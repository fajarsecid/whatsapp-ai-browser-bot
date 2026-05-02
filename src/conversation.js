export class ConversationStore {
  constructor({ maxTurns = 8, ttlMs = 180 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxTurns = maxTurns;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  buildInput(userId, userText, systemPrompt) {
    const session = this.getSession(userId);
    return [
      { role: 'developer', content: systemPrompt },
      ...session.messages,
      { role: 'user', content: userText }
    ];
  }

  append(userId, userText, assistantText) {
    const session = this.getSession(userId);
    session.messages.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText }
    );
    session.updatedAt = this.now();

    const maxMessages = this.maxTurns * 2;
    if (session.messages.length > maxMessages) {
      session.messages = session.messages.slice(-maxMessages);
    }
  }

  clear(userId) {
    this.sessions.delete(userId);
  }

  getSession(userId) {
    const existing = this.sessions.get(userId);
    if (existing && this.now() - existing.updatedAt <= this.ttlMs) {
      existing.updatedAt = this.now();
      return existing;
    }

    const session = { updatedAt: this.now(), messages: [] };
    this.sessions.set(userId, session);
    return session;
  }
}
