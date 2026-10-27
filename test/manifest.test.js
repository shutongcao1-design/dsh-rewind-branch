/**
 * Manifest checks: the package must stay installable as a DSH bundle and its
 * display resources must stay complete.
 */
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

test('package declares an installable DSH bundle', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.equal(pkg.private, undefined, 'an open-source package must not be private')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(typeof pkg.dsh?.engines?.dsh, 'string')
})

test('every file in the files whitelist exists', async () => {
  for (const entry of pkg.files) {
    await access(join(ROOT, entry))
  }
})

test('patch row id and name agree with the package name', async () => {
  const patch = await readFile(join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  assert.match(patch, new RegExp(`- id: ${pkg.name}\\b`))
  assert.match(patch, new RegExp(`name: ${pkg.name}\\b`))
})

test('client module id equals the package name', async () => {
  const client = await readFile(join(ROOT, 'client.js'), 'utf8')
  assert.match(client, new RegExp(`id: '${pkg.name}'`))
  assert.match(client, new RegExp(`const PKG = '${pkg.name}'`))
})

test('locale metadata is complete', async () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await readFile(join(ROOT, 'locale', `${locale}.json`), 'utf8'))
    assert.equal(typeof meta.meta?.title, 'string')
    assert.equal(typeof meta.meta?.description, 'string')
    assert.ok(meta.meta.title.length > 0)
    assert.ok(meta.meta.description.length > 0)
  }
})
