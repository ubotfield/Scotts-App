import express from "express";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3001;

// ─── Salesforce config ───────────────────────────────────────────
const SF_LOGIN_URL =
  process.env.SF_INSTANCE_URL || "https://login.salesforce.com";
const SF_CLIENT_ID = process.env.SF_CLIENT_ID!;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET!;
const SF_AGENT_ID = process.env.SF_AGENT_ID!;

// ─── Token cache ─────────────────────────────────────────────────
let cachedToken: string | null = null;
let cachedInstanceUrl: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<{
  accessToken: string;
  instanceUrl: string;
}> {
  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && cachedInstanceUrl && Date.now() < tokenExpiry - 300_000) {
    return { accessToken: cachedToken, instanceUrl: cachedInstanceUrl };
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
  // Default 2-hour expiry for Client Credentials tokens
  tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;

  console.log("[auth] Token acquired. Instance URL:", cachedInstanceUrl);
  return { accessToken: cachedToken!, instanceUrl: cachedInstanceUrl! };
}

/** Clear cached token so next request re-authenticates */
function invalidateToken() {
  cachedToken = null;
  cachedInstanceUrl = null;
  tokenExpiry = 0;
}

/**
 * Generic fetch wrapper with automatic token refresh on 401.
 */
async function sfFetch(
  path: string,
  options: RequestInit & { instanceUrl?: string } = {},
  retry = true
): Promise<Response> {
  const { accessToken, instanceUrl } =
    await getAccessToken();
  const url = `${options.instanceUrl || instanceUrl}${path}`;

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
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}/messages?sync=true`,
      {
        method: "POST",
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

    console.log("[message] Agent response:", responseText.substring(0, 100) + "...");
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
app.delete("/api/agent/session", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  try {
    const sfRes = await sfFetch(
      `/einstein/ai-agent/v1/sessions/${sessionId}`,
      { method: "DELETE" }
    );

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
 * Queries the QSR_Menu_Item__c custom object.
 */
app.get("/api/menu", async (_req, res) => {
  try {
    const query = encodeURIComponent(
      "SELECT Id, Name, Price__c, Description__c, Category__c, Calories__c, Is_Available__c FROM QSR_Menu_Item__c WHERE Is_Available__c = true ORDER BY Category__c, Name"
    );

    const sfRes = await sfFetch(
      `/services/data/v62.0/query/?q=${query}`
    );

    if (!sfRes.ok) {
      const err = await sfRes.text();
      console.error("[menu] Query failed:", sfRes.status, err);
      // Fallback to static menu if custom object doesn't exist
      return res.json({ items: getStaticMenu(), source: "static" });
    }

    const data = await sfRes.json();
    const items = (data.records || []).map((r: any) => ({
      id: r.Id,
      name: r.Name,
      price: r.Price__c,
      description: r.Description__c,
      category: r.Category__c,
      calories: r.Calories__c,
      available: r.Is_Available__c,
    }));

    return res.json({ items, source: "salesforce" });
  } catch (err: any) {
    console.error("[menu] Error:", err.message);
    // Fallback to static menu
    return res.json({ items: getStaticMenu(), source: "static" });
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
    agentId: SF_AGENT_ID ? `${SF_AGENT_ID.substring(0, 8)}...` : "not set",
  });
});

// ─── Static menu fallback ────────────────────────────────────────
function getStaticMenu() {
  return [
    {
      id: "static-1",
      name: "Classic Fresh Burger",
      price: 12.99,
      description: "Grass-fed beef patty with fresh lettuce, tomato, and house-made sauce on a brioche bun.",
      category: "Burgers",
      calories: 650,
      available: true,
    },
    {
      id: "static-2",
      name: "Grilled Chicken Wrap",
      price: 10.99,
      description: "Herb-marinated chicken breast with avocado, spinach, and chipotle aioli in a whole wheat wrap.",
      category: "Wraps",
      calories: 480,
      available: true,
    },
    {
      id: "static-3",
      name: "Harvest Power Bowl",
      price: 13.49,
      description: "Quinoa, roasted sweet potato, chickpeas, kale, and tahini dressing.",
      category: "Bowls",
      calories: 520,
      available: true,
    },
    {
      id: "static-4",
      name: "Wild-Caught Salmon Plate",
      price: 16.99,
      description: "Pan-seared salmon with seasonal vegetables and lemon herb rice.",
      category: "Entrees",
      calories: 580,
      available: true,
    },
    {
      id: "static-5",
      name: "Garden Fresh Salad",
      price: 9.49,
      description: "Mixed greens, cherry tomatoes, cucumber, red onion, and balsamic vinaigrette.",
      category: "Salads",
      calories: 280,
      available: true,
    },
    {
      id: "static-6",
      name: "Fresh Passion Fruit Spritz",
      price: 5.99,
      description: "Sparkling water with fresh passion fruit, mint, and a splash of lime.",
      category: "Beverages",
      calories: 90,
      available: true,
    },
    {
      id: "static-7",
      name: "Sweet Potato Fries",
      price: 5.49,
      description: "Crispy hand-cut sweet potato fries with rosemary sea salt.",
      category: "Sides",
      calories: 340,
      available: true,
    },
    {
      id: "static-8",
      name: "Açaí Energy Bowl",
      price: 11.99,
      description: "Blended açaí with banana, granola, coconut flakes, and fresh berries.",
      category: "Bowls",
      calories: 410,
      available: true,
    },
  ];
}

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍽️  Scott's Fresh Kitchens API Server`);
  console.log(`   Running on http://localhost:${PORT}`);
  console.log(`   Agent ID: ${SF_AGENT_ID || "NOT SET"}`);
  console.log(`   Instance: ${SF_LOGIN_URL}`);
  console.log(
    `   Auth: ${SF_CLIENT_ID && SF_CLIENT_SECRET ? "Configured" : "⚠️  Missing credentials"}\n`
  );
});
