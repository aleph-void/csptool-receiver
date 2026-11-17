'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'install.sh');
const lib = path.join(root, 'deploy/install-lib.sh');
const run = args => spawnSync('bash', [installer, ...args], { encoding: 'utf8' });

it('previews a hostname installation without requiring root or changing the host', () => {
  const result = run(['reports.example.com', '--port', '3456', '--node-major', '26', '--dry-run']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('127.0.0.1:3456');
  expect(result.stdout).toContain('Node: 26');
});
it.each(['https://reports.example.com', 'example.com;id', '../example.com', '*.example.com', 'bad..example.com', '-bad.example.com', '127.0.0.1', 'example.com\nserver {}'])('rejects unsafe or non-hostname input: %s', host => {
  expect(run([host, '--dry-run']).status).not.toBe(0);
});
it.each([['--port', '80'], ['--port', '65536'], ['--node-major', '22'], ['--cert-name', '../other'], ['--propagation-seconds', '0'], ['--email', 'not-an-email'], ['--port']])('rejects invalid options: %s %s', (...args) => {
  expect(run(['reports.example.com', ...args, '--dry-run']).status).not.toBe(0);
});
it('selects a matching wildcard Certbot lineage and verifies the private key', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'receiver-cert-test-'));
  const lineage = path.join(temporary, 'example.com-0001');
  mkdirSync(lineage);
  const key = path.join(lineage, 'privkey.pem');
  const certificate = path.join(lineage, 'fullchain.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=*.example.com', '-addext', 'subjectAltName=DNS:*.example.com', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    const selected = execFileSync('bash', ['-c', 'source "$1"; find_certificate "$2" "$3" ""', '--', lib, temporary, 'reports.example.com'], { encoding: 'utf8' }).trim();
    expect(selected).toBe(lineage);
    expect(spawnSync('bash', ['-c', 'source "$1"; find_certificate "$2" "$3" ""', '--', lib, temporary, 'different.test']).status).not.toBe(0);
    expect(spawnSync('bash', ['-c', 'source "$1"; validate_certificate "$2" "$3"', '--', lib, lineage, 'reports.example.com']).status).toBe(0);
    execFileSync('openssl', ['genrsa', '-out', key, '2048'], { stdio: 'ignore' });
    expect(spawnSync('bash', ['-c', 'source "$1"; validate_certificate "$2" "$3"', '--', lib, lineage, 'reports.example.com']).status).not.toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
