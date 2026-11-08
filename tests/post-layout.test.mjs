import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// eslint-disable-next-line test/no-import-node-test
import { it } from 'node:test'

const layout = readFileSync(new URL('../src/layouts/Layout.astro', import.meta.url), 'utf8')
const postPage = readFileSync(new URL('../src/pages/[...lang]/posts/[slug].astro', import.meta.url), 'utf8')
const toc = readFileSync(new URL('../src/components/Widgets/TOC.astro', import.meta.url), 'utf8')
const extensionStyles = readFileSync(new URL('../src/styles/extension.css', import.meta.url), 'utf8')

it('post pages use a left TOC and centered content column', () => {
  assert.match(postPage, /<article class="heti post-page">/)
  assert.match(postPage, /<div class="post-header">/)
  assert.match(extensionStyles, /grid-template-areas:\s*"toc header"\s*"toc content"/)
  assert.match(extensionStyles, /grid-template-columns:\s*12rem minmax\(0, 44rem\)/)
})

it('the desktop TOC participates in the post layout instead of pinning to the viewport edge', () => {
  assert.match(toc, /lg:\(sticky top-20/)
  assert.doesNotMatch(toc, /fixed left-0/)
})

it('post pages omit the right-side site chrome', () => {
  assert.match(layout, /\{!isPost && <Header \/>\}/)
  assert.match(layout, /\{!isPost && <Navbar \/>\}/)
  assert.match(layout, /\{!isPost && <Footer \/>\}/)
  assert.match(layout, /\{!isPost && <Button supportedLangs=\{supportedLangs\} \/>\}/)
})

it('post pages retain top spacing after the site chrome is removed', () => {
  assert.match(extensionStyles, /\.post-layout \.site-shell\s*\{[^}]*padding-top:\s*5rem/)
})

it('the shared site shell keeps a static class so desktop attributify rules are generated', () => {
  assert.match(layout, /class="site-shell mx-auto max-w-205\.848 min-h-vh w-full min-h-dvh"/)
  assert.doesNotMatch(layout, /<div\s+class:list=/)
  assert.match(layout, /isPost \? 'scroll-smooth post-layout' : ''/)
})
