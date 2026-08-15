import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCodexMcpServersFromToml,
  updateCodexMcpServerEnabledInToml,
  listAllMcpServers,
} from '../dist-server/mcp.js';

test('parseCodexMcpServersFromToml extracts servers with enabled state and transports', () => {
  const toml = `
[mcp_servers.rider]
url = "http://127.0.0.1:64342/stream"

[mcp_servers.meta-xr-operator]
command = 'F:\\QuestVR\\meta-xr-operator-mcp-proxy.exe'

[mcp_servers.metahorizon]
command = 'E:\\Program Files\\hzos-dev-mcp.exe'
enabled = false
`;

  const servers = parseCodexMcpServersFromToml(toml);
  assert.equal(servers.length, 3);

  const rider = servers.find((s) => s.name === 'rider');
  assert.ok(rider);
  assert.equal(rider.enabled, true);
  assert.equal(rider.url, 'http://127.0.0.1:64342/stream');

  const meta = servers.find((s) => s.name === 'meta-xr-operator');
  assert.ok(meta);
  assert.equal(meta.enabled, true);
  assert.equal(meta.command, 'F:\\QuestVR\\meta-xr-operator-mcp-proxy.exe');

  const horizon = servers.find((s) => s.name === 'metahorizon');
  assert.ok(horizon);
  assert.equal(horizon.enabled, false);
});

test('updateCodexMcpServerEnabledInToml correctly updates or adds enabled flag', () => {
  const toml = `
[mcp_servers.rider]
url = "http://127.0.0.1:64342/stream"

[mcp_servers.metahorizon]
command = 'E:\\Program Files\\hzos-dev-mcp.exe'
enabled = false
`;

  // Disable rider
  const updatedRider = updateCodexMcpServerEnabledInToml(toml, 'rider', false);
  const parsedDisabled = parseCodexMcpServersFromToml(updatedRider);
  assert.equal(parsedDisabled.find((s) => s.name === 'rider')?.enabled, false);

  // Enable metahorizon
  const updatedHorizon = updateCodexMcpServerEnabledInToml(toml, 'metahorizon', true);
  const parsedEnabled = parseCodexMcpServersFromToml(updatedHorizon);
  assert.equal(parsedEnabled.find((s) => s.name === 'metahorizon')?.enabled, true);
});

test('listAllMcpServers returns aggregated servers across the system', async () => {
  const servers = await listAllMcpServers(true);
  assert.ok(Array.isArray(servers));
  assert.ok(servers.length >= 1, 'Expected at least 1 MCP server to be discovered');

  for (const s of servers) {
    assert.ok(typeof s.id === 'string');
    assert.ok(typeof s.name === 'string');
    assert.ok(typeof s.enabled === 'boolean');
    assert.ok(typeof s.toolCount === 'number');
    assert.ok(s.models && typeof s.models === 'object');
  }
});
