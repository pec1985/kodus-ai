/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    testBYOK,
    testBYOKModel,
} from "@services/organizationParameters/fetch";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RotatePanel } from "./rotate-panel";

jest.mock("@services/organizationParameters/fetch", () => ({
    testBYOK: jest.fn(async () => ({ ok: true, latencyMs: 1 })),
    testBYOKModel: jest.fn(async () => ({ ok: true, latencyMs: 1 })),
}));
jest.mock("@services/organizationParameters/hooks", () => ({
    useSuspenseGetLLMProviders: () => ({
        providers: [
            {
                id: "chatgpt_subscription",
                name: "Codex",
                requiresBaseURL: false,
            },
        ],
    }),
    useModelCapabilities: () => ({ data: undefined }),
}));
const credential = {
    id: "codex",
    provider: "chatgpt_subscription",
    settings: {
        accountId: "original",
        codexAccessToken: "••••",
        codexRefreshToken: "••••",
    },
};
function setup() {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
        <RotatePanel
            credential={credential}
            probeModelId="test-model"
            onSave={onSave}
            onCancel={jest.fn()}
        />,
    );
    return onSave;
}
beforeEach(() => jest.clearAllMocks());
test("imports, tests, and saves replacement credentials", async () => {
    const onSave = setup();
    const file = {
        size: 100,
        text: async () =>
            JSON.stringify({
                tokens: {
                    access_token: "new-access",
                    refresh_token: "new-refresh",
                    account_id: "new-account",
                },
            }),
    };
    fireEvent.change(screen.getByLabelText("Import Codex auth.json"), {
        target: { files: [file] },
    });
    await screen.findByRole("status");
    expect(screen.getByLabelText("Access token")).toHaveAttribute(
        "type",
        "password",
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith("", {
            codexAccessToken: "new-access",
            codexRefreshToken: "new-refresh",
            accountId: "new-account",
        }),
    );
    expect(testBYOK).toHaveBeenCalledWith(
        expect.objectContaining({
            provider: "chatgpt_subscription",
            codexAccessToken: "new-access",
            codexRefreshToken: "new-refresh",
            accountId: "new-account",
        }),
    );
    expect(testBYOKModel).not.toHaveBeenCalled();
});
test("keeps stored tokens blank and probes the stored credential", async () => {
    const onSave = setup();
    expect(screen.getByLabelText("Access token")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith("", { accountId: "original" }),
    );
    expect(testBYOKModel).toHaveBeenCalledWith(
        expect.objectContaining({ credentialId: "codex" }),
    );
    expect(testBYOK).not.toHaveBeenCalled();
});
test("rejects incomplete replacement and account-only changes", async () => {
    const onSave = setup();
    fireEvent.change(screen.getByLabelText("Account ID"), {
        target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await screen.findByText(/Import credentials or fill in all three fields/);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Access token"), {
        target: { value: "only-access" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await screen.findByText(/Import credentials or fill in all three fields/);
    expect(onSave).not.toHaveBeenCalled();
    expect(testBYOK).not.toHaveBeenCalled();
});
test("shows invalid import errors without exposing file contents", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Import Codex auth.json"), {
        target: { files: [{ size: 10, text: async () => "secret-invalid" }] },
    });
    expect(
        await screen.findByText(/Could not import credentials/),
    ).toBeVisible();
    expect(screen.queryByText("secret-invalid")).not.toBeInTheDocument();
});
