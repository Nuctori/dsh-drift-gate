# 部署记录（desktop profile）

本文件记录本插件在**本机 desktop profile** 的实际安装动作，供回滚与复核。

## 目标

- 插件：`dsh-drift-gate@0.1.0`
- 源码：`D:\projects\dsh-drift-gate`
- profile：`C:\Users\Nuctori\.dsh\profiles\desktop`

## 为什么不是 `dsh plugin add`

desktop profile 由 Electron 独占管理，CLI 明确拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

因此改为等价的手工配置 + `pnpm install`（与 UI 安装写入的是同一组文件）。

## 实际改动

1. `profiles/desktop/package.json`
   - `dependencies` 增加：`"dsh-drift-gate": "file:D:/projects/dsh-drift-gate"`
   - `dsh.profile.bundles` 追加：`"dsh-drift-gate"`
2. 在 `profiles/desktop` 执行：
   ```
   pnpm install --prefer-offline
   ```
   输出 `Done in 2.3s`，`pnpm-lock.yaml` 已记录 `dsh-drift-gate: file:D:/projects/dsh-drift-gate`。
3. 副作用：`pnpm install` 报告 `Packages: +6 -7`（依赖树有增删，非本插件单独引入）。

## 备份

安装前已复制：

- `profiles/desktop/package.json.bak-pre-drift-gate`
- `profiles/desktop/cordis.patch.yml.bak-pre-drift-gate`

`cordis.patch.yml` 实际未被修改（插件行由 bundle 自带的 patch 提供），该备份仅作保险。

## 回滚

1. 从 `profiles/desktop/package.json` 删除：
   - `dependencies["dsh-drift-gate"]`
   - `dsh.profile.bundles` 中的 `"dsh-drift-gate"`
2. 在 `profiles/desktop` 执行 `pnpm install`。
3. 重启 desktop 宿主。
4. 必要时用 `package.json.bak-pre-drift-gate` 覆盖回滚。

## 验证

- 静态：`node_modules/dsh-drift-gate/lib/index.js` 存在，且含 `toolFilter` 与 `minConfidence`。
- 运行时：重启 desktop 后，插件列表出现 `drift-gate`，且无加载报错。
- 行为：制造一次明显跑题的回答，回合结束前应出现以 `[drift-gate]` 开头的注入。
