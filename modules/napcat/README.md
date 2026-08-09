# NapCat Windows 多账号登录态隔离

NapCat 的 Windows 一键包（`NapCat.Shell.Windows.OneKey`）里，QQ 的登录态默认全部
存在同一个 `%APPDATA%\QQ` 目录。同时跑多个 QQ 机器人账号时，谁最后登录谁就覆盖
`auth\login.enc`，导致其它账号每次启动都“快速登录失败”，只能重新扫码。

这个模块给出一份最小补丁：在 QQ（Electron）启动入口里，根据环境变量
`NAPCAT_QQ_DATA_DIR` 把 `userData` 指到每个账号自己的目录，登录态从此互不干扰，
重启后各自快速登录。

## 原理

`NapCat.Shell.Windows.OneKey` 里 QQ 的入口是：

```text
<NapCat 目录>/versions/<版本>/resources/app/package.json
```

其中 `main` 指向 `./napcat/napcat.mjs`。补丁把 `main` 改成一个包装入口
`qq-entry.mjs`，它在加载 `napcat.mjs` 之前先执行：

```js
app.setPath("userData", process.env.NAPCAT_QQ_DATA_DIR);
```

Chromium 子进程（GPU / network / node）随后都会带上对应的
`--user-data-dir=<目录>`，QQ 的登录状态、分区数据库等全部落在各自目录里。

## 应用步骤

1. 把 `qq-entry.mjs` 复制到：

   ```text
   <NapCat 目录>/versions/<版本>/resources/app/qq-entry.mjs
   ```

2. 修改同目录 `package.json`，把：

   ```json
   "main": "./napcat/napcat.mjs"
   ```

   改为：

   ```json
   "main": "./qq-entry.mjs"
   ```

   注意保存为 **UTF-8 无 BOM**（NapCat 用 `JSON.parse` 读它，BOM 会直接报错）。

3. 给每个账号准备独立数据目录，例如：

   ```text
   D:\napcat-data\10001\qq
   D:\napcat-data\10002\qq
   ```

4. 启动每个 NapCat 实例前设置环境变量，例如 VBS 启动脚本里：

   ```vbs
   ws.Environment("Process")("NAPCAT_QQ_DATA_DIR") = "D:\napcat-data\10001\qq"
   ws.Run "cmd /c chcp 65001 >nul & NapCatWinBootMain.exe 10001", 0, False
   ```

5. 首次启动时每个账号各扫码登录一次；之后重启都会自动快速登录。

> 旧登录态迁移：如果之前所有账号共用一个 `%APPDATA%\QQ`，可以把整个目录复制进
> 其中**最后登录的那个账号**的新目录，那个账号可以免扫码直接快速登录，其余账号
> 扫码一次即可。

## 注意

- 更新 / 重新解压 NapCat 一键包后，`package.json` 会被重置，需要重新打这个补丁。
- `webui.json` 和 `onebot11_<uin>.json` 等 NapCat 配置仍在安装目录里（按 QQ 号
  分文件），不受本次隔离影响。
