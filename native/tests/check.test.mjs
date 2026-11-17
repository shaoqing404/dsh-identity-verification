import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const binary = process.argv[2]
assert.ok(binary, 'expected the built helper path')

function invoke(args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.error, undefined, `helper invocation failed: ${result.error}`)
  assert.ok(result.stdout.endsWith('\n'), 'response is a newline-terminated JSON object')
  assert.equal(result.stdout.trim().split('\n').length, 1, 'exactly one JSON response')
  return { status: result.status, value: JSON.parse(result.stdout) }
}

const check = invoke(['--check'])
assert.equal(check.status, 0)
assert.equal(check.value.schemaVersion, 1)
assert.equal(check.value.operation, 'check')
assert.ok(['none', 'touch-id', 'face-id', 'optic-id', 'unknown'].includes(check.value.biometryType))
for (const policy of ['systemOwner', 'biometricsOnly']) {
  const probe = check.value[policy]
  assert.equal(typeof probe.available, 'boolean')
  assert.ok(probe.reason === null || typeof probe.reason === 'string')
  if (probe.available) assert.equal(probe.reason, null)
}

for (const args of [[], ['--check', '--unknown']]) {
  const invalid = invoke(args)
  assert.equal(invalid.status, 2)
  assert.equal(invalid.value.operation, 'invalid')
  assert.equal(invalid.value.outcome, 'error')
  assert.equal(invalid.value.reason, 'invalid_command')
}
console.log(`No-prompt check passed: ${JSON.stringify(check.value)}`)
