import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: "audio/*", limit: "10mb" }));

// ─── CORS (needed for AI Studio iframe serving) ─────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// AI Studio assigns PORT via env; fallback to 3001 for local dev
const PORT = process.env.PORT || 3001;

// ─── Salesforce config (supports both SF_ and SALESFORCE_ env var names) ───
const SF_LOGIN_URL =
  process.env.SF_INSTANCE_URL || process.env.SALESFORCE_ORG_URL || "https://login.salesforce.com";
const SF_CLIENT_ID = (process.env.SF_CLIENT_ID || process.env.SALESFORCE_CLIENT_ID)!;
const SF_CLIENT_SECRET = (process.env.SF_CLIENT_SECRET || process.env.SALESFORCE_CLIENT_SECRET)!;
const SF_AGENT_ID = (process.env.SF_AGENT_ID || process.env.AGENT_ID)!;

// ╔════════════════════════════════════════════════════════════════════╗
// ║ CRITICAL: Agent API calls MUST go to https://api.salesforce.com   ║
// ║ NOT the org instance URL. The org URL returns "URL No Longer       ║
// ║ Exists" for /einstein/ai-agent/v1/* paths. DO NOT CHANGE THIS.    ║
// ╚════════════════════════════════════════════════════════════════════╝
const AGENT_API_BASE = "https://api.salesforce.com";

// ─── Token cache ─────────────────────────────────────────────────
let cachedToken: string | null = null;
let cachedInstanceUrl: string | null = null;
let cachedApiInstanceUrl: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<{
  accessToken: string;
  instanceUrl: string;
  apiInstanceUrl: string;
}> {
  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && cachedInstanceUrl && cachedApiInstanceUrl && Date.now() < tokenExpiry - 300_000) {
    return { accessToken: cachedToken, instanceUrl: cachedInstanceUrl, apiInstanceUrl: cachedApiInstanceUrl };
  }

  console.log("[auth] Fetching new access token via Client Credentials...");

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[auth] Token request failed:", res.status, err);
    throw new Error(`OAuth token request failed: ${res.status} — ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedInstanceUrl = data.instance_url;
  // Agent API uses api.salesforce.com (returned as api_instance_url)
  cachedApiInstanceUrl = data.api_instance_url || "https://api.salesforce.com";
  // Default 2-hour expiry for Client Credentials tokens
  tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;

  console.log("[auth] Token acquired. Instance URL:", cachedInstanceUrl);
  console.log("[auth] API Instance URL:", cachedApiInstanceUrl);
  return { accessToken: cachedToken!, instanceUrl: cachedInstanceUrl!, apiInstanceUrl: cachedApiInstanceUrl! };
}

/** Clear cached token so next request re-authenticates */
function invalidateToken() {
  cachedToken = null;
  cachedInstanceUrl = null;
  cachedApiInstanceUrl = null;
  tokenExpiry = 0;
}

/**
 * Generic fetch wrapper with automatic token refresh on 401.
 * Set useApiUrl=true for Agent API calls (routes through api.salesforce.com).
 */
async function sfFetch(
  path: string,
  options: RequestInit & { instanceUrl?: string; useApiUrl?: boolean } = {},
  retry = true
): Promise<Response> {
  const { accessToken, instanceUrl, apiInstanceUrl } =
    await getAccessToken();

  // Agent API calls MUST go through api.salesforce.com (hardcoded constant);
  // data queries go through the org instance URL from OAuth response.
  const baseUrl = options.useApiUrl ? AGENT_API_BASE : (options.instanceUrl || instanceUrl);
  const url = `${baseUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });

  // If 401, refresh token once and retry
  if (res.status === 401 && retry) {
    console.log("[auth] 401 received — refreshing token and retrying...");
    invalidateToken();
    return sfFetch(path, options, false);
  }

  return res;
}

// ─── Routes ──────────────────────────────────────────────────────

/**
 * POST /api/agent/session
 * Create a new Agentforce agent session.
 */
app.post("/api/agent/session", async (_req, res) => {
  try {
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/agents/${SF_AGENT_ID}/sessions`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          externalSessionKey: `scotts-app-${Date.now()}`,
          instanceConfig: {
            endpoint: SF_LOGIN_URL,
          },
          streamingCapabilities: {
            chunkTypes: ["Text"],
          },
          bypassUser: true,
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[session] Create failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Failed to create agent session", detail: err });
    }

    const data = await sfRes.json();
    console.log("[session] Created:", data.sessionId);
    return res.json({ sessionId: data.sessionId });
  } catch (err: any) {
    console.error("[session] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agent/message
 * Send a message to the agent and get a synchronous response.
 * Body: { sessionId: string, message: string, sequenceId: number }
 */
app.post("/api/agent/message", async (req, res) => {
  const { sessionId, message, sequenceId } = req.body;

  if (!sessionId || !message || !sequenceId) {
    return res.status(400).json({ error: "sessionId, message, and sequenceId are required" });
  }

  try {
    const agentStart = Date.now();
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}/messages?sync=true`,
      {
        method: "POST",
        useApiUrl: true,
        body: JSON.stringify({
          message: {
            sequenceId,
            type: "Text",
            text: message,
          },
          variables: [],
        }),
      }
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[message] Send failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Agent message failed", detail: err });
    }

    const data = await sfRes.json();

    // Extract text from the agent response
    // The response structure: { messages: [{ type: "Text", message: "..." }, ...] }
    let responseText = "";
    if (data.messages && Array.isArray(data.messages)) {
      responseText = data.messages
        .filter((m: any) => m.type === "Text" || m.type === "Inform")
        .map((m: any) => m.message || m.text || "")
        .join("\n")
        .trim();
    }

    // Fallback: check for different response structures
    if (!responseText && data.text) {
      responseText = data.text;
    }

    console.log(`[message] Agent responded in ${Date.now() - agentStart}ms:`, responseText.substring(0, 100) + "...");
    return res.json({ response: responseText, raw: data });
  } catch (err: any) {
    console.error("[message] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/agent/session
 * End an agent session.
 * Body: { sessionId: string }
 */
app.delete("/api/agent/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    // CRITICAL: Agent API DELETE must NOT have a body or Content-Type header.
    // Sending a body causes "ConstraintViolationException: arg2 must not be null".
    const { accessToken } = await getAccessToken();
    const url = `${AGENT_API_BASE}/einstein/ai-agent/v1/sessions/${sessionId}`;

    const sfRes = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      // NO body, NO Content-Type
    });

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[session] End failed:", sfRes.status, err);
      return res.status(sfRes.status).json({ error: "Failed to end session", detail: err });
    }

    console.log("[session] Ended:", sessionId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[session] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/menu
 * Fetch menu items from Salesforce.
 * Queries the Menu_Item__c custom object with Menu_Category__r relationship.
 */
app.get("/api/menu", async (_req, res) => {
  try {
    const query = encodeURIComponent(
      "SELECT Id, Name, Price__c, Description__c, Calories__c, Is_Popular__c, Is_Available__c, Customizations__c, Menu_Category__r.Name FROM Menu_Item__c WHERE Is_Available__c = true ORDER BY Menu_Category__r.Sort_Order__c, Is_Popular__c DESC, Name ASC"
    );

    const sfRes = await sfFetch(
      `/services/data/v62.0/query/?q=${query}`
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[menu] Query failed:", sfRes.status, err);
      // Fallback to static menu if query fails
      return res.json({ items: getStaticMenu(), source: "static" });
    }

    const data = await sfRes.json();
    const items = (data.records || []).map((r: any) => ({
      id: r.Id,
      name: r.Name,
      price: r.Price__c,
      description: r.Description__c,
      category: r.Menu_Category__r?.Name || "Other",
      calories: r.Calories__c,
      isPopular: r.Is_Popular__c || false,
      available: r.Is_Available__c,
      customizations: r.Customizations__c ? JSON.parse(r.Customizations__c) : null,
    }));

    return res.json({ items, source: "salesforce" });
  } catch (err: any) {
    console.error("[menu] Error:", err.message);
    // Fallback to static menu
    return res.json({ items: getStaticMenu(), source: "static" });
  }
});

/**
 * POST /api/tts
 * Text-to-Speech via ElevenLabs API.
 * Returns MP3 audio directly (no PCM/WAV conversion needed).
 * Body: { text: string }
 * Returns: audio/mpeg binary
 */
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // Default: George (warm male)

app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }

  if (!ELEVENLABS_API_KEY) {
    console.warn("[tts] No ELEVENLABS_API_KEY — returning 503");
    return res.status(503).json({ error: "TTS not configured" });
  }

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ttsStart = Date.now();
      console.log(`[tts] ElevenLabs attempt ${attempt}/${MAX_RETRIES}: "${text.substring(0, 60)}..."`);

      // 10s timeout — ElevenLabs is typically ~300ms but guard against edge cases
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const apiRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": ELEVENLABS_API_KEY,
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              speed: 1.0,
            },
          }),
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);

      console.log(`[tts] Attempt ${attempt} took ${Date.now() - ttsStart}ms, status: ${apiRes.status}`);

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        console.error(`[tts] Attempt ${attempt} failed: ${apiRes.status}`, errText.substring(0, 200));

        // Retry on 500, 502, 503, 429 (rate limit)
        if ((apiRes.status >= 500 || apiRes.status === 429) && attempt < MAX_RETRIES) {
          const delay = attempt * 500;
          console.log(`[tts] Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return res.status(502).json({ error: "TTS generation failed" });
      }

      // ElevenLabs returns MP3 binary directly — no JSON parsing needed
      const audioBuffer = Buffer.from(await apiRes.arrayBuffer());
      console.log(`[tts] Got MP3 audio: ${audioBuffer.length} bytes (attempt ${attempt}, ${Date.now() - ttsStart}ms)`);

      res.set("Content-Type", "audio/mpeg");
      res.set("Content-Length", String(audioBuffer.length));
      return res.send(audioBuffer);
    } catch (err: any) {
      const isTimeout = err.name === "AbortError";
      console.error(`[tts] Attempt ${attempt} error:`, isTimeout ? "Timed out (10s)" : err.message);

      if (attempt < MAX_RETRIES) {
        const delay = attempt * 500;
        console.log(`[tts] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(502).json({ error: "TTS failed after all retries" });
});

/**
 * POST /api/stt
 * Speech-to-Text via Gemini REST API.
 * Receives audio as base64 JSON ({ audio: string, mimeType: string })
 * Returns: { text: string }
 *
 * Used as fallback when Web Speech API (SpeechRecognition) is unavailable
 * (iOS Chrome, PWA standalone mode, WKWebView).
 */
app.post("/api/stt", async (req, res) => {
  const { audio, mimeType } = req.body;
  if (!audio) {
    return res.status(400).json({ error: "audio (base64) is required" });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: "STT not configured" });
  }

  try {
    const sttStart = Date.now();
    // Use Gemini Flash for audio transcription
    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType || "audio/webm",
                    data: audio,
                  },
                },
                {
                  text: "Transcribe this audio exactly. Return ONLY the spoken text, nothing else. If no speech is detected, return an empty string.",
                },
              ],
            },
          ],
        }),
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("[stt] Gemini API failed:", apiRes.status, errText);
      return res.status(502).json({ error: "STT failed" });
    }

    const data = await apiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    console.log(`[stt] Transcribed in ${Date.now() - sttStart}ms:`, text.substring(0, 100));
    return res.json({ text });
  } catch (err: any) {
    console.error("[stt] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/health
 * Health check endpoint.
 */
app.get("/api/health", async (_req, res) => {
  const hasConfig = !!(SF_CLIENT_ID && SF_CLIENT_SECRET && SF_AGENT_ID);
  res.json({
    status: "ok",
    hasConfig,
    loginUrl: SF_LOGIN_URL || "not set",
    agentId: SF_AGENT_ID ? `${SF_AGENT_ID.substring(0, 8)}...` : "not set",
    clientIdSet: !!SF_CLIENT_ID,
    clientSecretSet: !!SF_CLIENT_SECRET,
    tts: {
      provider: "elevenlabs",
      keySet: !!ELEVENLABS_API_KEY,
      voiceId: ELEVENLABS_VOICE_ID,
    },
    stt: {
      provider: "gemini",
      keySet: !!process.env.GEMINI_API_KEY,
    },
    envSource: {
      SF_INSTANCE_URL: !!process.env.SF_INSTANCE_URL,
      SALESFORCE_ORG_URL: !!process.env.SALESFORCE_ORG_URL,
      SF_CLIENT_ID: !!process.env.SF_CLIENT_ID,
      SALESFORCE_CLIENT_ID: !!process.env.SALESFORCE_CLIENT_ID,
      SF_CLIENT_SECRET: !!process.env.SF_CLIENT_SECRET,
      SALESFORCE_CLIENT_SECRET: !!process.env.SALESFORCE_CLIENT_SECRET,
      SF_AGENT_ID: !!process.env.SF_AGENT_ID,
      AGENT_ID: !!process.env.AGENT_ID,
    },
  });
});

// ─── Static menu fallback (mirrors actual Salesforce Menu_Item__c data) ───
function getStaticMenu() {
  return [
    // Burgers
    { id: "s-1", name: "Classic Fresh Burger", price: 12.99, description: "Our signature quarter-pound beef patty with fresh lettuce, tomato, pickles, and our house-made sauce on a toasted brioche bun.", category: "Burgers", calories: 650, isPopular: true, available: true },
    { id: "s-2", name: "Crispy Chicken Sandwich", price: 13.49, description: "Crispy buttermilk-fried chicken breast with coleslaw, pickles, and spicy mayo on a toasted bun.", category: "Burgers", calories: 720, isPopular: true, available: true },
    { id: "s-3", name: "Double Stack Burger", price: 15.99, description: "Two quarter-pound patties stacked high with double cheese, caramelized onions, and smoky BBQ sauce.", category: "Burgers", calories: 950, isPopular: true, available: true },
    { id: "s-4", name: "Veggie Garden Burger", price: 11.99, description: "House-made plant-based patty with roasted peppers, arugula, and herb aioli. Fresh, wholesome, and delicious.", category: "Burgers", calories: 480, isPopular: false, available: true },
    // Steaks & Grills
    { id: "s-5", name: "Grilled Filet Mignon", price: 24.99, description: "Premium 8oz filet mignon grilled to your liking, served with herb butter and fresh-cut fries.", category: "Steaks & Grills", calories: 680, isPopular: true, available: true },
    { id: "s-6", name: "Herb-Crusted Ribeye", price: 22.99, description: "12oz ribeye with a rosemary-garlic crust, served with roasted vegetables.", category: "Steaks & Grills", calories: 850, isPopular: false, available: true },
    { id: "s-7", name: "BBQ Grilled Chicken", price: 16.99, description: "Juicy half chicken basted in our house-made BBQ sauce, slow-grilled over open flame.", category: "Steaks & Grills", calories: 620, isPopular: true, available: true },
    // Pasta & Bowls
    { id: "s-8", name: "Carbonara", price: 14.99, description: "Classic spaghetti carbonara with crispy pancetta, parmesan, egg yolk, and cracked black pepper.", category: "Pasta & Bowls", calories: 780, isPopular: true, available: true },
    { id: "s-9", name: "Grilled Chicken Bowl", price: 14.49, description: "Herb-marinated grilled chicken over quinoa with roasted vegetables, avocado, and lemon tahini dressing.", category: "Pasta & Bowls", calories: 550, isPopular: true, available: true },
    { id: "s-10", name: "Penne Arrabbiata", price: 13.49, description: "Penne in a fiery tomato sauce with garlic, chili flakes, and fresh basil.", category: "Pasta & Bowls", calories: 620, isPopular: false, available: true },
    // Sides
    { id: "s-11", name: "Fresh-Cut Fries", price: 4.49, description: "Hand-cut fries, crispy on the outside, fluffy inside. Seasoned with sea salt.", category: "Sides", calories: 380, isPopular: true, available: true },
    { id: "s-12", name: "Sweet Potato Fries", price: 5.49, description: "Crispy sweet potato fries served with chipotle aioli dipping sauce.", category: "Sides", calories: 340, isPopular: false, available: true },
    { id: "s-13", name: "Onion Rings", price: 5.49, description: "Beer-battered onion rings, golden and crunchy, served with ranch dipping sauce.", category: "Sides", calories: 420, isPopular: false, available: true },
    { id: "s-14", name: "Garden Salad", price: 6.99, description: "Mixed greens, cherry tomatoes, cucumber, red onion, and croutons with your choice of dressing.", category: "Sides", calories: 180, isPopular: false, available: true },
    // Fresh Juices & Drinks
    { id: "s-15", name: "Fresh Lemonade", price: 4.99, description: "Hand-squeezed lemon juice with just the right amount of sweetness. Served ice cold.", category: "Fresh Juices & Drinks", calories: 120, isPopular: true, available: true },
    { id: "s-16", name: "Tropical Mango Smoothie", price: 5.99, description: "Creamy mango, banana, and coconut milk blended to tropical perfection.", category: "Fresh Juices & Drinks", calories: 280, isPopular: true, available: true },
    { id: "s-17", name: "Berry Blast Smoothie", price: 5.49, description: "A vibrant mix of strawberries, blueberries, raspberries, and Greek yogurt.", category: "Fresh Juices & Drinks", calories: 220, isPopular: false, available: true },
    { id: "s-18", name: "Green Detox Juice", price: 6.99, description: "A revitalizing blend of kale, cucumber, celery, green apple, and fresh ginger.", category: "Fresh Juices & Drinks", calories: 90, isPopular: false, available: true },
    // Desserts
    { id: "s-19", name: "Chocolate Brownie", price: 5.99, description: "Rich, fudgy chocolate brownie baked fresh daily. Served warm with a scoop of vanilla ice cream.", category: "Desserts", calories: 480, isPopular: true, available: true },
    { id: "s-20", name: "Fresh Fruit Cup", price: 4.99, description: "A colorful mix of seasonal fresh fruits — strawberries, blueberries, mango, and kiwi.", category: "Desserts", calories: 120, isPopular: false, available: true },
  ];
}

// ─── Serve built frontend (Vite dist) ────────────────────────────
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback: serve index.html for all non-API routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍽️  Scott's Fresh Kitchens API Server`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Agent ID: ${SF_AGENT_ID || "NOT SET"}`);
  console.log(`   Instance: ${SF_LOGIN_URL}`);
  console.log(
    `   Auth: ${SF_CLIENT_ID && SF_CLIENT_SECRET ? "Configured ✓" : "⚠️  Missing credentials"}`
  );
  console.log(
    `   TTS: ElevenLabs ${ELEVENLABS_API_KEY ? "Configured ✓" : "⚠️  Missing ELEVENLABS_API_KEY"} (voice: ${ELEVENLABS_VOICE_ID})`
  );
  console.log(`   Env vars present:`);
  console.log(`     SF_CLIENT_ID: ${!!process.env.SF_CLIENT_ID}`);
  console.log(`     SALESFORCE_CLIENT_ID: ${!!process.env.SALESFORCE_CLIENT_ID}`);
  console.log(`     SF_CLIENT_SECRET: ${!!process.env.SF_CLIENT_SECRET}`);
  console.log(`     SALESFORCE_CLIENT_SECRET: ${!!process.env.SALESFORCE_CLIENT_SECRET}`);
  console.log(`     SF_AGENT_ID: ${!!process.env.SF_AGENT_ID}`);
  console.log(`     AGENT_ID: ${!!process.env.AGENT_ID}`);
  console.log(`     SF_INSTANCE_URL: ${!!process.env.SF_INSTANCE_URL}`);
  console.log(`     SALESFORCE_ORG_URL: ${!!process.env.SALESFORCE_ORG_URL}`);
  console.log(`     ELEVENLABS_API_KEY: ${!!process.env.ELEVENLABS_API_KEY}`);
  console.log(`     PORT: ${process.env.PORT || "(not set, using default)"}\n`);
});
