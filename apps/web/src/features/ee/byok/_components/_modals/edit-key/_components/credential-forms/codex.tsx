"use client";

import { useState } from "react";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../../_types";
import { SecretInput } from "../secret-input";
import { parseCodexAuth } from "./codex-auth";

export function CodexFields() {
    const form = useFormContext<EditKeyForm>();
    const [importError, setImportError] = useState<string>();
    const [imported, setImported] = useState(false);
    return (
        <div className="flex flex-col gap-4">
            <div className="bg-card-lv2 rounded-lg p-4 text-sm">
                <p className="font-medium">Connect your ChatGPT subscription</p>
                <p className="text-text-secondary mt-2">
                    Run <code>codex login</code> on your computer and sign in
                    with your ChatGPT account. Import <code>auth.json</code>{" "}
                    from your <code>~/.codex</code> folder (or your custom{" "}
                    <code>CODEX_HOME</code> folder).
                </p>
                <p className="text-text-secondary mt-2">
                    Kodus stores the imported tokens encrypted for your
                    organization and uses them for code reviews.
                </p>
            </div>
            <FormControl.Root>
                <FormControl.Label htmlFor="codex-auth-file">
                    Import Codex auth.json
                </FormControl.Label>
                <input
                    id="codex-auth-file"
                    type="file"
                    accept=".json,application/json"
                    className="text-sm"
                    onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        setImported(false);
                        setImportError(undefined);
                        if (!file) return;
                        try {
                            if (file.size > 1024 * 1024)
                                throw new Error(
                                    "Choose an auth.json smaller than 1 MB.",
                                );
                            const credentials = parseCodexAuth(
                                await file.text(),
                            );
                            for (const key of Object.keys(credentials) as Array<
                                keyof typeof credentials
                            >) {
                                form.setValue(key, credentials[key], {
                                    shouldDirty: true,
                                    shouldValidate: true,
                                });
                            }
                            setImported(true);
                        } catch {
                            setImportError(
                                "Could not import credentials. Choose a Codex auth.json under 1 MB with access_token, refresh_token, and account_id from a ChatGPT login.",
                            );
                        }
                    }}
                />
                {importError && (
                    <p role="alert" className="text-danger text-sm">
                        {importError}
                    </p>
                )}
                {imported && (
                    <p role="status" className="text-success text-sm">
                        Credentials imported. Choose a model, then test and save
                        to connect.
                    </p>
                )}
            </FormControl.Root>
            <details>
                <summary className="cursor-pointer text-sm">
                    Enter credentials manually
                </summary>
                <div className="mt-4 flex flex-col gap-4">
                    {(
                        [
                            ["codexAccessToken", "Access token"],
                            ["codexRefreshToken", "Refresh token"],
                            ["accountId", "Account ID"],
                        ] as const
                    ).map(([name, label]) => (
                        <Controller
                            key={name}
                            name={name}
                            control={form.control}
                            render={({ field, fieldState }) => (
                                <FormControl.Root>
                                    <FormControl.Label htmlFor={name}>
                                        {label}
                                    </FormControl.Label>
                                    <FormControl.Input>
                                        {name === "accountId" ? (
                                            <Input
                                                {...field}
                                                id={name}
                                                value={field.value ?? ""}
                                                autoComplete="off"
                                            />
                                        ) : (
                                            <SecretInput
                                                {...field}
                                                id={name}
                                                value={field.value ?? ""}
                                                error={fieldState.error}
                                            />
                                        )}
                                    </FormControl.Input>
                                </FormControl.Root>
                            )}
                        />
                    ))}
                </div>
            </details>
            {(
                ["codexAccessToken", "codexRefreshToken", "accountId"] as const
            ).some((key) => form.formState.errors[key]) && (
                <p role="alert" className="text-danger text-sm">
                    Import credentials or fill in all three fields. To keep
                    stored credentials, leave both tokens blank and keep the
                    account ID unchanged.
                </p>
            )}
        </div>
    );
}
