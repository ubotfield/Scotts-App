/**
 * Client-side helper for communicating with the Agentforce Agent API
 * via the Express server proxy at /api/agent/*.
 */

export type AgentMessage = {
  role: "user" | "agent";
  text: string;
  timestamp: number;
};

export class AgentforceSession {
  private sessionId: string | null = null;
  private sequenceId: number = 0;
  private _messages: AgentMessage[] = [];

  get messages(): AgentMessage[] {
    return [...this._messages];
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  /**
   * Start a new agent session.
   */
  async start(): Promise<void> {
    const res = await fetch("/api/agent/session", { method: "POST" });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Failed to start session: ${res.status}`);
    }

    const data = await res.json();
    this.sessionId = data.sessionId;
    this.sequenceId = 0;
    this._messages = [];
    console.log("[agentforce] Session started:", this.sessionId);
  }

  /**
   * Send a text message to the agent and receive a response.
   * Returns the agent's text response.
   */
  async sendMessage(text: string): Promise<string> {
    if (!this.sessionId) {
      throw new Error("No active session. Call start() first.");
    }

    this.sequenceId++;

    // Track user message
    this._messages.push({
      role: "user",
      text,
      timestamp: Date.now(),
    });

    const res = await fetch("/api/agent/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        message: text,
        sequenceId: this.sequenceId,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Message failed: ${res.status}`);
    }

    const data = await res.json();
    const responseText = data.response || "I didn't catch that. Could you try again?";

    // Track agent response
    this._messages.push({
      role: "agent",
      text: responseText,
      timestamp: Date.now(),
    });

    return responseText;
  }

  /**
   * End the current agent session.
   */
  async end(): Promise<void> {
    if (!this.sessionId) return;

    try {
      await fetch("/api/agent/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId }),
      });
      console.log("[agentforce] Session ended:", this.sessionId);
    } catch (err) {
      console.warn("[agentforce] Failed to end session cleanly:", err);
    }

    this.sessionId = null;
    this.sequenceId = 0;
  }
}
