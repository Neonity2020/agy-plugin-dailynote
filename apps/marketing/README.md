# Daily Notes — Landing Page

Daily Notes 插件的营销落地页，基于 [Astro](https://astro.build) 静态构建，无客户端框架运行时。

## 开发

```bash
# 在仓库根目录执行
pnpm install
pnpm dev:marketing      # http://localhost:4321
```

## 构建与预览

```bash
pnpm build:marketing    # 产物输出到 apps/marketing/dist/
pnpm --filter @daily-notes/marketing preview
```

`dist/` 是纯静态目录，可直接托管到任意静态站点服务（Cloudflare Pages、Netlify、GitHub Pages 等）。

> 若部署在 GitHub Pages 的子路径（如 `https://<user>.github.io/agy-plugin-dailynote/`），请在
> `astro.config.mjs` 中补充 `base: '/agy-plugin-dailynote'`，并把 `site` 改为实际域名。

## 修改内容

- 页面文案与段落组件位于 `src/components/`，主页面在 `src/pages/index.astro`。
- GitHub 仓库、ZIP 下载、Issues 链接集中在 `src/config.ts`，换仓库只需改这里。
- 设计令牌（配色、间距、字体）在 `src/styles/global.css`，与插件侧边栏的暗色主题保持一致。
- 图标为内联 SVG，统一在 `src/components/Icon.astro` 中维护。
