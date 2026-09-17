import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Browser, type LaunchOptions } from 'playwright';
import { AppError, publicError } from '../../config/src/index.ts';
import { browserNameSchema, browserLabels, type BrowserName } from '../../contracts/src/browser-choice.ts';

export type BrowserLaunchEvent = {
  type: 'browser.launching' | 'browser.launch.failed' | 'browser.ready';
  attempt: number;
  executablePath: string;
  message: string;
  retrying?: boolean;
  error?: string;
  version?: string;
  browserName: BrowserName;
  engine: 'playwright';
};
type Options = {
  browserName?: BrowserName;
  signal?: AbortSignal;
  beforeAttempt?: () => Promise<void>;
  onEvent?: (event: BrowserLaunchEvent) => Promise<void>;
};
type Dependencies = {
  launch?: (options: LaunchOptions) => Promise<Browser>;
  exists?: (path: string) => boolean;
  executablePath?: string;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export async function browserEngine(
  options: Options = {},
  dependencies: Dependencies = {},
): Promise<Browser> {
  const browserName = browserNameSchema.parse(options.browserName ?? 'chrome');
  const label = browserLabels[browserName];
  const pathVariable =
    browserName === 'firefox'
      ? 'FIREFOX_EXECUTABLE_PATH'
      : browserName === 'edge'
        ? 'EDGE_EXECUTABLE_PATH'
        : 'CHROME_EXECUTABLE_PATH';
  const preferred =
    dependencies.executablePath ??
    (process.env[pathVariable] ||
      (browserName === 'chrome' ? process.env.BROWSER_EXECUTABLE_PATH : undefined));
  const exists = dependencies.exists ?? fs.existsSync;
  // An explicit selection must not silently switch browser engines or ignore a typo.
  const candidates = preferred
    ? [preferred]
    : browserName === 'firefox'
      ? [firefox.executablePath()]
      : browserName === 'edge'
        ? [
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            ...(process.env.LOCALAPPDATA
              ? [`${process.env.LOCALAPPDATA}/Microsoft/Edge/Application/msedge.exe`]
              : []),
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            ...(process.env.LOCALAPPDATA
              ? [`${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`]
              : []),
            '/usr/bin/google-chrome',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ];
  const executablePath = candidates.find(exists);
  if (!executablePath)
    throw new AppError(
      'BROWSER_MISSING',
      preferred
        ? `${label} 的配置路径不存在，请检查 ${pathVariable} 后重试`
        : browserName === 'firefox'
          ? '执行服务器缺少 Playwright Firefox，请运行 pnpm exec playwright install firefox'
          : `执行服务器未安装 ${label}，请安装或配置 ${pathVariable}`,
    );
  const launch =
    dependencies.launch ??
    ((args: LaunchOptions) => (browserName === 'firefox' ? firefox : chromium).launch(args));
  const wait =
    dependencies.wait ??
    (async (ms: number, signal?: AbortSignal) => {
      await delay(ms, undefined, { signal });
    });
  for (let attempt = 1; attempt <= 2; attempt++) {
    options.signal?.throwIfAborted();
    await options.beforeAttempt?.();
    await options.onEvent?.({
      type: 'browser.launching',
      browserName,
      engine: 'playwright',
      attempt,
      executablePath,
      message: `正在通过 Playwright 启动 ${label}（第 ${attempt}/2 次）`,
    });
    let browser: Browser | undefined;
    let version: string;
    try {
      browser = await launch({
        executablePath,
        headless: true,
        args: browserName === 'firefox' ? [] : ['--lang=zh-CN', '--disable-dev-shm-usage'],
        timeout: 30000,
      });
      version = browser.version();
    } catch (error) {
      await browser?.close().catch(() => {});
      const retrying = attempt < 2 && !options.signal?.aborted;
      await options.onEvent?.({
        type: 'browser.launch.failed',
        browserName,
        engine: 'playwright',
        attempt,
        executablePath,
        retrying,
        error: publicError(error),
        message: retrying
          ? '浏览器启动失败，尚未访问网站；稍后重试启动'
          : '浏览器启动失败，尚未访问网站或执行登录',
      });
      options.signal?.throwIfAborted();
      if (!retrying)
        throw new AppError(
          'BROWSER_LAUNCH_FAILED',
          '隔离浏览器连续两次启动失败，尚未访问网站或执行登录。请查看执行时间线中的启动诊断，检查本机浏览器或 BROWSER_EXECUTABLE_PATH。',
        );
      await wait(1000, options.signal);
      continue;
    }
    try {
      options.signal?.throwIfAborted();
      await options.beforeAttempt?.();
      await options.onEvent?.({
        type: 'browser.ready',
        browserName,
        engine: 'playwright',
        attempt,
        executablePath,
        version,
        message: `${label} 已就绪：${version} · Playwright / Midscene`,
      });
      return browser;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
  throw new AppError('BROWSER_LAUNCH_FAILED', '浏览器未能启动');
}
