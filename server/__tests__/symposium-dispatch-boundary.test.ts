import { describe, expect, it, vi } from 'vitest';
import { assertSymposiumSeatDispatchCurrent } from '../symposium-dispatch-boundary.js';
import { symposiumDispatchFixture as fixture } from './fixtures/symposium-dispatch.js';

describe('transport-neutral Symposium dispatch authority', () => {
  it('returns the current seat after checking durable facts and trusted grants in order', () => {
    const f = fixture();
    const checks: string[] = [];
    for (const key of Object.keys(f.deps.facts) as Array<keyof typeof f.deps.facts>) {
      const original = f.deps.facts[key]!;
      Object.assign(f.deps.facts, {
        [key]: (...args: never[]) => {
          checks.push(key);
          return (original as (...args: never[]) => unknown)(...args);
        },
      });
    }
    f.deps.hostGrants.verifySeat.mockImplementation(() => {
      checks.push('verifySeat');
    });
    expect(assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants)).toBe(
      f.config.seats[0],
    );
    expect(checks).toEqual([
      'assertSymposiumArtifactWorkAllowed',
      'getActiveSymposiumConfig',
      'getLatestSymposiumMembership',
      'verifySeat',
      'getLatestSymposiumAdmission',
      'getSymposiumDelivery',
    ]);
  });

  it('checks cancellation before reading facts or verifying a grant', () => {
    const f = fixture();
    const reason = new Error('stopped exact attempt');
    f.controller.abort(reason);
    expect(() =>
      assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants),
    ).toThrow(reason);
    expect(f.deps.facts.assertSymposiumArtifactWorkAllowed).not.toHaveBeenCalled();
    expect(f.deps.hostGrants.verifySeat).not.toHaveBeenCalled();
  });

  it.each(['changed', 'missing'])('rejects a %s exact artifact before the work fence', (state) => {
    const f = fixture();
    const artifact = {
      version: 1 as const,
      transitionId: 'transition',
      artifactGenerationId: 'selected',
      pointerRevision: 1,
      bindingDigest: 'a'.repeat(64),
    };
    if (!('version' in f.input.provenance)) throw new Error('Versioned fixture required');
    f.input.provenance = { ...f.input.provenance, version: 3, artifact };
    f.deps.facts.getSymposiumArtifactReference = vi.fn(() =>
      state === 'missing' ? null : { ...artifact, pointerRevision: 2 },
    );
    expect(() =>
      assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants),
    ).toThrow('Exact current seat artifact reference required');
    expect(f.deps.facts.getSymposiumArtifactReference).toHaveBeenCalledWith(
      'parent',
      'contributor',
      1,
    );
    expect(f.deps.facts.assertSymposiumArtifactWorkAllowed).not.toHaveBeenCalled();
  });

  it('passes the exact retained artifact to the work fence', () => {
    const f = fixture();
    const artifact = {
      version: 1 as const,
      transitionId: 'transition',
      artifactGenerationId: 'selected',
      pointerRevision: 1,
      bindingDigest: 'a'.repeat(64),
    };
    if (!('version' in f.input.provenance)) throw new Error('Versioned fixture required');
    f.input.provenance = { ...f.input.provenance, version: 3, artifact };
    f.deps.facts.getSymposiumArtifactReference = () => ({ ...artifact });
    assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants);
    expect(f.deps.facts.assertSymposiumArtifactWorkAllowed).toHaveBeenCalledWith(
      'parent',
      artifact,
    );
  });

  it.each([
    ['revision', 'Symposium configuration changed before native dispatch'],
    ['inactive', 'Symposium configuration changed before native dispatch'],
    ['budget', 'Budgeted native execution requires a trusted provider cost reservation'],
    ['seat', 'Symposium seat binding changed before native dispatch'],
    ['binding', 'Symposium execution provenance does not match the seat'],
    ['provenance', 'Symposium execution provenance changed before native dispatch'],
    ['membership', 'Symposium membership is not current and confirmed'],
    ['unconfirmed', 'Symposium membership is not current and confirmed'],
    ['admission', 'Current-generation provider admission is missing'],
  ])('preserves the %s rejection and its grant ordering', (state, error) => {
    const f = fixture();
    if (state === 'revision') f.config.revision++;
    if (state === 'inactive') f.config.state = 'draft';
    if (state === 'budget') f.config.turnRules = { mode: 'budgeted', maxTurns: 8, budgetUsd: 1 };
    if (state === 'seat') f.config.seats = [{ ...f.input.seat, name: 'Changed' }];
    if (state === 'binding' && 'accountBinding' in f.input.provenance)
      f.input.provenance.accountBinding = { ...f.input.seat.accountBinding!, model: 'different' };
    if (state === 'provenance' && 'seatLabel' in f.input.provenance)
      f.input.provenance.seatLabel = 'Changed';
    if (state === 'membership' || state === 'unconfirmed') {
      const membership = f.deps.facts.getLatestSymposiumMembership('parent', 'contributor')!;
      f.deps.facts.getLatestSymposiumMembership = () => ({
        ...membership,
        generation: state === 'membership' ? 2 : 1,
        reconciliation: state === 'unconfirmed' ? 'recovery_required' : 'confirmed',
      });
    }
    if (state === 'admission') {
      const admission = f.deps.facts.getLatestSymposiumAdmission('parent', 'contributor', 2)!;
      f.deps.facts.getLatestSymposiumAdmission = () => ({ ...admission, membershipGeneration: 2 });
    }
    expect(() =>
      assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants),
    ).toThrow(error);
    expect(f.deps.hostGrants.verifySeat).toHaveBeenCalledTimes(state === 'admission' ? 1 : 0);
  });

  it('propagates a revoked host grant before reading admission or delivery', () => {
    const f = fixture();
    const admission = vi.spyOn(f.deps.facts, 'getLatestSymposiumAdmission');
    const delivery = vi.spyOn(f.deps.facts, 'getSymposiumDelivery');
    f.deps.hostGrants.verifySeat.mockImplementation(() => {
      throw new Error('host grant revoked');
    });
    expect(() =>
      assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants),
    ).toThrow('host grant revoked');
    expect(admission).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
  });

  it.each(['missing', 'session', 'status', 'content', 'recipient', 'key', 'generation'])(
    'rejects changed delivery %s after verifying the grant',
    (state) => {
      const f = fixture();
      const delivery = f.deps.facts.getSymposiumDelivery('delivery')!;
      if (state === 'session') delivery.sessionId = 'other';
      if (state === 'status') delivery.status = 'delivered';
      if (state === 'content') delivery.deliveredContent = 'other content';
      if (state === 'recipient') delivery.recipients[0].status = 'completed';
      if (state === 'key') delivery.recipients[0].idempotencyKey = 'other';
      if (state === 'generation') delivery.recipients[0].membershipGeneration = 2;
      f.deps.facts.getSymposiumDelivery = () => (state === 'missing' ? null : delivery);
      expect(() =>
        assertSymposiumSeatDispatchCurrent(f.deps.facts, f.input, f.deps.hostGrants),
      ).toThrow('Symposium recipient delivery changed before native dispatch');
      expect(f.deps.hostGrants.verifySeat).toHaveBeenCalledTimes(1);
    },
  );
});
