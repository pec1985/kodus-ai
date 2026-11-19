/** Read only the three credentials needed by Kodus; never retain the source file. */
export function parseCodexAuth(contents: string) {
    const invalid = () =>
        new Error(
            "Choose a Codex auth.json containing access_token, refresh_token, and account_id. Sign in with your ChatGPT account using codex login first.",
        );
    if (contents.length > 1024 * 1024) throw invalid();
    let value: unknown;
    try {
        value = JSON.parse(contents);
    } catch {
        throw invalid();
    }
    if (!value || typeof value !== "object" || !("tokens" in value))
        throw invalid();
    const tokens = value.tokens;
    if (!tokens || typeof tokens !== "object") throw invalid();
    const read = (key: string) => {
        const value = (tokens as Record<string, unknown>)[key];
        if (typeof value !== "string" || !value.trim()) throw invalid();
        return value.trim();
    };
    return {
        codexAccessToken: read("access_token"),
        codexRefreshToken: read("refresh_token"),
        accountId: read("account_id"),
    };
}
