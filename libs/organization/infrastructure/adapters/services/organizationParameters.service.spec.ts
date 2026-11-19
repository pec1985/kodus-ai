import { decrypt, encrypt } from '@libs/common/utils/crypto';
import type { BYOKConfig } from '@libs/llm/byok-config';
import { setCodexCredentialStore } from '@libs/llm/codex-subscription-model';
import type { IOrganizationParametersRepository } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersService } from './organizationParameters.service';

function storedConfig(accessToken: string, refreshToken: string): BYOKConfig {
    return {
        version: 2,
        credentials: [
            {
                id: 'credential-id',
                provider: 'chatgpt_subscription',
                settings: {
                    codexAccessToken: encrypt(accessToken),
                    codexRefreshToken: encrypt(refreshToken),
                    accountId: 'account-id',
                    unrelated: 'preserved',
                },
            },
        ],
        models: [
            {
                id: 'model-id',
                credentialId: 'credential-id',
                model: 'gpt-5.6-luna',
            },
        ],
    };
}

function parameter(configValue: BYOKConfig): OrganizationParametersEntity {
    return new OrganizationParametersEntity({
        uuid: 'parameter-id',
        configKey: OrganizationParametersKey.BYOK_CONFIG,
        configValue,
        organization: { uuid: 'organization-id' },
    });
}

describe('OrganizationParametersService Codex token rotation', () => {
    afterEach(() => setCodexCredentialStore(undefined));

    it('encrypts rotation at rest and atomically compares the current config', async () => {
        const current = storedConfig('old-access', 'old-refresh');
        const repository = {
            findByKeyAndValue: jest
                .fn()
                .mockResolvedValue([parameter(current)]),
            compareAndSwapConfigValue: jest.fn().mockResolvedValue(true),
        };
        const service = new OrganizationParametersService(
            repository as unknown as IOrganizationParametersRepository,
        );

        await expect(
            service.rotateCodexTokens({
                credentialId: 'credential-id',
                organizationId: 'organization-id',
                expectedRefreshToken: 'old-refresh',
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                accountId: 'account-id',
            }),
        ).resolves.toEqual({
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            accountId: 'account-id',
        });

        expect(repository.findByKeyAndValue).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'organization-id',
                },
            }),
        );
        const [uuid, expected, replacement] =
            repository.compareAndSwapConfigValue.mock.calls[0];
        expect(uuid).toBe('parameter-id');
        expect(expected).toBe(current);
        const settings = replacement.credentials[0].settings;
        expect(settings.unrelated).toBe('preserved');
        expect(settings.codexAccessToken).not.toBe('new-access');
        expect(settings.codexRefreshToken).not.toBe('new-refresh');
        expect(decrypt(settings.codexAccessToken)).toBe('new-access');
        expect(decrypt(settings.codexRefreshToken)).toBe('new-refresh');
    });

    it('uses the CAS winner tokens after a concurrent rotation', async () => {
        const current = storedConfig('old-access', 'old-refresh');
        const winner = storedConfig('winner-access', 'winner-refresh');
        const repository = {
            findByKeyAndValue: jest
                .fn()
                .mockResolvedValueOnce([parameter(current)])
                .mockResolvedValueOnce([parameter(winner)]),
            compareAndSwapConfigValue: jest.fn().mockResolvedValue(false),
        };
        const service = new OrganizationParametersService(
            repository as unknown as IOrganizationParametersRepository,
        );

        await expect(
            service.rotateCodexTokens({
                credentialId: 'credential-id',
                organizationId: 'organization-id',
                expectedRefreshToken: 'old-refresh',
                accessToken: 'loser-access',
                refreshToken: 'loser-refresh',
                accountId: 'account-id',
            }),
        ).resolves.toEqual({
            accessToken: 'winner-access',
            refreshToken: 'winner-refresh',
            accountId: 'account-id',
        });
        expect(repository.compareAndSwapConfigValue).toHaveBeenCalledTimes(1);
        expect(repository.findByKeyAndValue).toHaveBeenCalledTimes(2);
    });
});

describe('Codex refresh coordination', () => {
    it('reads the current tenant credential only after acquiring its database lock', async () => {
        let locked = false;
        const repository = {
            withCodexRefreshLock: jest.fn(async (_key, action) => {
                locked = true;
                try {
                    return await action();
                } finally {
                    locked = false;
                }
            }),
            findByKeyAndValue: jest.fn(async () => {
                expect(locked).toBe(true);
                return [
                    parameter(storedConfig('winner-access', 'winner-refresh')),
                ];
            }),
        };
        const service = new OrganizationParametersService(
            repository as unknown as IOrganizationParametersRepository,
        );
        const action = jest.fn(async (latest) => {
            expect(locked).toBe(true);
            return latest;
        });
        await expect(
            service.withRefreshLock(
                {
                    accessToken: 'stale',
                    accountId: 'account-id',
                    credentialId: 'credential-id',
                    organizationId: 'organization-id',
                },
                action,
            ),
        ).resolves.toEqual({
            accessToken: 'winner-access',
            refreshToken: 'winner-refresh',
            accountId: 'account-id',
        });
        expect(repository.withCodexRefreshLock).toHaveBeenCalledWith(
            'codex-refresh:organization-id:credential-id',
            expect.any(Function),
        );
        expect(repository.findByKeyAndValue).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: { organizationId: 'organization-id' },
            }),
        );
        expect(locked).toBe(false);
    });
});

describe('Codex tokens during model deletion', () => {
    it('keeps a concurrent rotation when deleting a different model', async () => {
        const before = storedConfig('old-access', 'old-refresh');
        before.models.push({
            id: 'remove-me',
            credentialId: 'credential-id',
            model: 'gpt-5.6-sol',
        });
        const winner = {
            ...before,
            credentials: storedConfig('winner-access', 'winner-refresh')
                .credentials,
        };
        const repository = {
            findByKey: jest
                .fn()
                .mockResolvedValueOnce(parameter(before))
                .mockResolvedValue(parameter(winner)),
            compareAndSwapConfigValue: jest
                .fn()
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true),
            update: jest.fn(),
        };
        const service = new OrganizationParametersService(
            repository as unknown as IOrganizationParametersRepository,
        );
        await expect(
            service.deleteByokModel('organization-id', 'remove-me'),
        ).resolves.toBe(true);
        expect(repository.update).not.toHaveBeenCalled();
        const saved = repository.compareAndSwapConfigValue.mock.calls[1][2];
        expect(saved.models.map((m) => m.id)).toEqual(['model-id']);
        expect(decrypt(saved.credentials[0].settings.codexRefreshToken)).toBe(
            'winner-refresh',
        );
    });
});
