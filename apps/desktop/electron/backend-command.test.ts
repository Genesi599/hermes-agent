import assert from 'node:assert/strict'

import { test } from 'vitest'

import { dashboardFallbackArgs, normalizeBackendPort, serveBackendArgs, sourceDeclaresServe } from './backend-command'

test('serveBackendArgs builds a headless serve invocation', () => {
  assert.deepEqual(serveBackendArgs(), ['serve', '--host', '127.0.0.1', '--port', '0'])
})

test('serveBackendArgs accepts a validated fixed primary port', () => {
  assert.deepEqual(serveBackendArgs(undefined, normalizeBackendPort('8803')), [
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    '8803'
  ])
  assert.equal(normalizeBackendPort('invalid'), '0')
  assert.equal(normalizeBackendPort('70000'), '0')
})

test('serveBackendArgs pins a profile when provided', () => {
  assert.deepEqual(serveBackendArgs('worker'), ['--profile', 'worker', 'serve', '--host', '127.0.0.1', '--port', '0'])
})

test('dashboardFallbackArgs rewrites serve -> dashboard --no-open, keeping the -m prefix', () => {
  const serve = ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0']
  assert.deepEqual(dashboardFallbackArgs(serve), [
    '-m',
    'hermes_cli.main',
    'dashboard',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0'
  ])
})

test('dashboardFallbackArgs preserves a --profile flag ahead of serve', () => {
  const serve = ['-m', 'hermes_cli.main', '--profile', 'worker', 'serve', '--host', '127.0.0.1', '--port', '0']
  assert.deepEqual(dashboardFallbackArgs(serve), [
    '-m',
    'hermes_cli.main',
    '--profile',
    'worker',
    'dashboard',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0'
  ])
})

test('dashboardFallbackArgs is a no-op (copy) when there is no serve token', () => {
  const args = ['-m', 'hermes_cli.main', 'dashboard', '--no-open']
  const out = dashboardFallbackArgs(args)
  assert.deepEqual(out, args)
  assert.notEqual(out, args, 'should return a copy, not the same reference')
})

test('sourceDeclaresServe detects the serve subparser registration', () => {
  assert.equal(sourceDeclaresServe('subparsers.add_parser("serve", help="...")'), true)
  assert.equal(sourceDeclaresServe("subparsers.add_parser('serve')"), true)
  assert.equal(sourceDeclaresServe('subparsers.add_parser(\n        "serve",\n)'), true)
})

test('sourceDeclaresServe does not false-positive on the substring "server"', () => {
  const oldSource = `
    dashboard_parser = subparsers.add_parser("dashboard", help="Start the web UI dashboard")
    from hermes_cli.web_server import start_server  # web server
  `

  assert.equal(sourceDeclaresServe(oldSource), false)
})
