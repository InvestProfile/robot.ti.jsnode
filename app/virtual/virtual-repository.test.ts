import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AccountOpenedEvent, DepositEvent, InMemoryVirtualLedgerRepository } from './index';

const accountId = 'experiment-1x';
const occurredAt = '2026-08-29T10:00:00Z';
const account = Object.freeze({ virtualAccountId: accountId, name: 'Baseline 1x', status: 'active' as const, openedAt: occurredAt });
const opening = (): AccountOpenedEvent => ({ id: 'opened-1', virtualAccountId: accountId, occurredAt, kind: 'account-opened', amountKopecks: 1_000_000n });
const deposit = (amountKopecks = 10_000n): DepositEvent => ({ id: 'deposit-1', virtualAccountId: accountId, occurredAt, kind: 'deposit', amountKopecks });

describe('virtual ledger repository contract', () => {
    it('restores canonical state after restart-style load', async () => {
        const repository = new InMemoryVirtualLedgerRepository();
        await repository.createAccount(account, opening());
        await repository.append(deposit());
        const restored = await repository.load(accountId);
        assert.strictEqual(restored.cashKopecks, 1_010_000n);
        assert.deepStrictEqual(restored.entries.map(event => event.id), ['opened-1', 'deposit-1']);
    });

    it('rejects duplicate accounts and cross-account opening events', async () => {
        const repository = new InMemoryVirtualLedgerRepository();
        await repository.createAccount(account, opening());
        await assert.rejects(repository.createAccount(account, opening()), /already exists/);
        await assert.rejects(repository.createAccount({ ...account, virtualAccountId: 'other' }, opening()), /does not match/);
    });

    it('is idempotent only for an identical payload and rejects ID conflicts', async () => {
        const repository = new InMemoryVirtualLedgerRepository();
        await repository.createAccount(account, opening());
        await repository.append(deposit());
        const unchanged = await repository.append({ ...deposit() }, 'ignore');
        assert.strictEqual(unchanged.entries.length, 2);
        await assert.rejects(repository.append(deposit(10_001n), 'ignore'), /ID conflict/);
    });

    it('serializes concurrent appends and keeps missing accounts isolated', async () => {
        const repository = new InMemoryVirtualLedgerRepository();
        await repository.createAccount(account, opening());
        await Promise.all(Array.from({ length: 20 }, (_, index) => repository.append({ ...deposit(100n), id: `deposit-${index + 2}` })));
        const restored = await repository.load(accountId);
        assert.strictEqual(restored.entries.length, 21);
        assert.strictEqual(restored.cashKopecks, 1_002_000n);
        await assert.rejects(repository.append({ ...deposit(), virtualAccountId: 'missing' }), /not found/);
    });
});
