import { describe, expect, it } from 'vitest';

import {
  type FleetControlRequest,
  type FleetLaunchTemplate,
  validateFleetControlRequest,
  validateLaunchTemplate,
} from '../../core/src/controlContracts.js';

function launch(overrides: Partial<FleetLaunchTemplate> = {}): FleetLaunchTemplate {
  return {
    runtime: 'claude-code',
    role: 'worker',
    repo: 'F:/repo',
    cwd: 'F:/repo',
    providerProfileId: 'claude-fleet.inherit',
    modelId: 'claude-test-model',
    launchSource: 'fleet-control-api',
    requestedBy: 'user',
    policy: { mode: 'suggest' },
    ...overrides,
  };
}

function request(overrides: Partial<FleetControlRequest> = {}): FleetControlRequest {
  return {
    requestId: 'request-1',
    action: 'launch_instance',
    mode: 'suggest',
    requestedBy: 'user',
    launch: launch(),
    createdAt: 1,
    ...overrides,
  };
}

describe('Fleet Control API contracts', () => {
  it('accepts a safe suggest launch request', () => {
    expect(validateFleetControlRequest(request())).toBeNull();
  });

  it('requires approval-bound autonomous budgets and policy', () => {
    expect(
      validateFleetControlRequest(
        request({
          mode: 'autonomous',
          launch: launch({ policy: { mode: 'suggest' } }),
        }),
      ),
    ).toContain('autonomous launch policy');

    expect(
      validateFleetControlRequest(
        request({
          mode: 'autonomous',
          launch: launch({
            policy: { mode: 'autonomous', maxConcurrentInstances: 2 },
          }),
        }),
      ),
    ).toContain('token or cost budget');
  });

  it('allows autonomous delivery to an already-existing instance without a launch template', () => {
    expect(
      validateFleetControlRequest(
        request({
          requestId: 'request-delivery-1',
          action: 'deliver_work_item',
          mode: 'autonomous',
          launch: undefined,
          missionId: 'mission-1',
          workItemId: 'work-item-1',
          instanceId: 'agent-1',
        }),
      ),
    ).toBeNull();
  });

  it('requires a native session id when resuming', () => {
    expect(validateLaunchTemplate(launch({ sessionMode: 'resume' }))).toContain('sessionId');
  });

  it('rejects unsafe requester and instance identifiers', () => {
    expect(validateFleetControlRequest(request({ requestedBy: 'user\nsecret' }))).toContain(
      'safe non-empty identifier',
    );
    expect(validateFleetControlRequest(request({ instanceId: '../secret' }))).toContain(
      'safe non-empty identifier',
    );
  });

  it('does not make launch_instance optional or silently fallback', () => {
    expect(validateFleetControlRequest(request({ launch: undefined }))).toContain(
      'launch is required',
    );
  });

  it('rejects a Claude API launch without an explicit provider profile', () => {
    expect(
      validateFleetControlRequest(request({ launch: launch({ providerProfileId: undefined }) })),
    ).toBe('PROVIDER_PROFILE_REQUIRED');
  });
});
