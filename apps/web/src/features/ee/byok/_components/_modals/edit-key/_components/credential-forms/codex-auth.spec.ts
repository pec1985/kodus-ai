import { createKeySchema, editKeySchema } from "../../_types";
import {
    buildByokBlob,
    credentialSettingsFromConfig,
} from "../../../../byok-write";
import {
    nonSecretStoredSettings,
    providerSettingDefaults,
} from "../../credential-config";
import { parseCodexAuth } from "./codex-auth";

const credentials = {
    codexAccessToken: "access-test",
    codexRefreshToken: "refresh-test",
    accountId: "account-test",
};
const base = {
    provider: "chatgpt_subscription",
    model: "test-model",
    apiKey: "",
};
test("imports only Codex OAuth credentials", () => {
    expect(
        parseCodexAuth(
            JSON.stringify({
                tokens: {
                    access_token: credentials.codexAccessToken,
                    refresh_token: credentials.codexRefreshToken,
                    account_id: credentials.accountId,
                    id_token: "ignored",
                },
                extra: "ignored",
            }),
        ),
    ).toEqual(credentials);
});
test.each([
    "invalid-secret",
    "null",
    "[]",
    JSON.stringify({ OPENAI_API_KEY: "secret" }),
    JSON.stringify({ tokens: { access_token: "secret" } }),
    "x".repeat(1024 * 1024 + 1),
])("rejects invalid auth without echoing file contents %#", (input) => {
    expect(() => parseCodexAuth(input)).toThrow("Choose a Codex auth.json");
});
test("requires complete new credentials but keeps blank stored tokens", () => {
    expect(createKeySchema.safeParse(base).success).toBe(false);
    expect(createKeySchema.safeParse({ ...base, ...credentials }).success).toBe(
        true,
    );
    expect(
        editKeySchema.safeParse({ ...base, accountId: "account-test" }).success,
    ).toBe(true);
    expect(
        editKeySchema.safeParse({ ...base, codexAccessToken: "access-test" })
            .success,
    ).toBe(false);
    expect(
        editKeySchema.safeParse({ ...base, codexRefreshToken: "refresh-test" })
            .success,
    ).toBe(false);
});
test("seeds only account identity and strips masked tokens from carried credentials", () => {
    const settings = {
        ...credentials,
        codexAccessToken: "••••",
        codexRefreshToken: "••••",
    };
    expect(providerSettingDefaults(base.provider, settings)).toEqual({
        accountId: credentials.accountId,
    });
    expect(nonSecretStoredSettings(settings)).toEqual({
        accountId: credentials.accountId,
    });
    const connected = buildByokBlob(undefined, {
        kind: "connect",
        newCredential: { provider: base.provider, apiKey: "", settings },
        model: { model: base.model },
    });
    const routed = buildByokBlob(connected, {
        kind: "routing",
        routing: connected.routing!,
    });
    expect(routed.credentials[0].settings).toEqual({
        accountId: credentials.accountId,
    });
    expect(credentialSettingsFromConfig({ ...base, ...credentials })).toEqual(
        credentials,
    );
});
