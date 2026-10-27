# Jin's Notes

Personal blog for [jinmoza](https://github.com/jinmoza), published at [jinmoza.github.io](https://jinmoza.github.io/) and built with [Astro](https://astro.build/) using the MIT-licensed [Retypeset](https://github.com/radishzzz/astro-theme-retypeset) theme.

## Write a post

Add a Markdown file under `src/content/posts/`:

```md
---
title: 文章标题
published: 2026-10-19
description: 一句话摘要
tags:
  - 标签
lang: zh
---

正文从这里开始。
```

The source lives on `main`; the generated static site is published from the `gh-pages` branch.

## Local development

This project requires Node.js 24 and pnpm 10.

```sh
pnpm install
pnpm dev
```
