import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Keep the build-level test dependency-free.
import test from 'node:test'
import { parse } from 'node-html-parser'

const helloWorldPath = '/posts/hello-world/'

async function readPage(path) {
  return parse(await readFile(new URL(path, import.meta.url), 'utf8'))
}

test('post lists display each note count without incrementing it', async () => {
  const page = await readPage('../dist/index.html')
  const counter = page.querySelector(`[data-pageview-path="${helloWorldPath}"]`)

  assert.ok(counter, 'expected a pageview counter for the hello-world note')
  assert.equal(counter.getAttribute('data-pageview-update'), 'false')
  assert.match(counter.parentNode.textContent, /次阅读/)
})

test('post pages display and increment only the current note count', async () => {
  const page = await readPage('../dist/posts/hello-world/index.html')
  const counters = page.querySelectorAll('[data-pageview-path]')

  assert.equal(counters.length, 1)
  assert.equal(counters[0].getAttribute('data-pageview-path'), helloWorldPath)
  assert.equal(counters[0].getAttribute('data-pageview-update'), 'true')
  assert.match(counters[0].parentNode.textContent, /次阅读/)
})

test('pageview counters are omitted when no Waline server is configured', async () => {
  const noPageviewDist = process.env.NO_PAGEVIEW_DIST
  assert.ok(noPageviewDist, 'NO_PAGEVIEW_DIST must point to a build without Waline configured')
  const page = parse(await readFile(join(noPageviewDist, 'index.html'), 'utf8'))

  assert.equal(page.querySelector('[data-pageview-path]'), null)
})
