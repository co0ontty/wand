#!/usr/bin/env node
/**
 * 发布前自动化测试脚本
 *
 * 使用 Puppeteer 测试 Wand 核心功能
 *
 * 使用方法：
 *   node scripts/pre-release-test.js
 *
 * 前提条件：
 *   - Wand 服务正在运行 (https://localhost:8443)
 *   - 已安装 puppeteer: npm install puppeteer
 */

const puppeteer = require('puppeteer');

const BASE_URL = 'https://localhost:8443';

// 测试结果统计
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function log(message, type = 'info') {
  const prefix = {
    info: 'ℹ',
    pass: '✅',
    fail: '❌',
    warn: '⚠'
  };
  console.log(`${prefix[type] || 'ℹ'} ${message}`);
}

function recordTest(name, passed, error = null) {
  results.tests.push({ name, passed, error });
  if (passed) {
    results.passed++;
    log(name, 'pass');
  } else {
    results.failed++;
    log(`${name}: ${error}`, 'fail');
  }
}

async function runTests() {
  log('开始发布前自动化测试...');
  log(`目标地址：${BASE_URL}`);

  let browser;
  try {
    // 启动浏览器
    log('启动 Headless 浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--ignore-certificate-errors' // 忽略自签名证书错误
      ]
    });

    const page = await browser.newPage();

    // 设置 viewport
    await page.setViewport({ width: 1280, height: 800 });

    // 测试 1: 页面可以加载
    log('测试 1: 页面加载');
    try {
      const response = await page.goto(BASE_URL, {
        waitUntil: 'networkidle0',
        timeout: 10000
      });
      recordTest('页面加载成功', response.ok());
    } catch (e) {
      recordTest('页面加载成功', false, e.message);
      // 如果页面都打不开，后续测试无法进行
      log('无法继续测试，页面无法加载', 'fail');
      return;
    }

    // 测试 2: 页面标题正确
    log('测试 2: 页面标题');
    const title = await page.title();
    recordTest('页面标题正确', title.includes('Wand'), `标题：${title}`);

    // 测试 3: 登录表单存在
    log('测试 3: 登录表单');
    const loginForm = await page.$('#password');
    recordTest('登录表单存在', loginForm !== null);

    // 测试 4: 检查关键 CSS 类
    log('测试 4: 关键 CSS 类');
    const hasChatMessages = await page.evaluate(() => {
      const style = document.querySelector('style');
      return style && style.textContent.includes('.chat-messages');
    });
    recordTest('Chat 样式存在', hasChatMessages);

    // 测试 5: 检查 column-reverse 布局（消息自下而上）
    log('测试 5: 消息布局方向');
    const hasColumnReverse = await page.evaluate(() => {
      const style = document.querySelector('style');
      return style && style.textContent.includes('column-reverse');
    });
    recordTest('使用 column-reverse 布局', hasColumnReverse);

    // 测试 6: 检查悬浮窗快捷键组件
    log('测试 6: 悬浮窗快捷键');
    const hasFloatingControls = await page.evaluate(() => {
      return document.getElementById('floating-controls-toggle') !== null;
    });
    recordTest('悬浮窗快捷键组件存在', hasFloatingControls);

    // 测试 7: 检查快捷键按钮
    log('测试 7: 快捷键按钮');
    const hasQuickInputButtons = await page.evaluate(() => {
      const buttons = document.querySelectorAll('.quick-input');
      return buttons.length > 0;
    });
    recordTest('快捷键按钮存在', hasQuickInputButtons, `找到 ${results.tests[results.tests.length-1]?.passed ? '' : '0'} 个按钮`);

    // 测试 8: 检查 JavaScript 无语法错误
    log('测试 8: JavaScript 语法');
    const jsErrors = await page.evaluate(() => {
      return window.__jsErrors || [];
    });

    // 监听控制台错误
    let consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 重新加载页面并检查错误
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForTimeout(2000); // 等待 2 秒让错误出现

    consoleErrors = await page.evaluate(() => consoleErrors);
    recordTest('无 JavaScript 语法错误', consoleErrors.length === 0, consoleErrors.join('; '));

    // 测试 9: 检查关键函数存在
    log('测试 9: 关键函数');
    const hasGetControlInput = await page.evaluate(() => {
      return typeof getControlInput === 'function';
    });
    recordTest('getControlInput 函数存在', hasGetControlInput);

    // 测试 10: 检查控制序列
    log('测试 10: 控制序列');
    const controlSequences = await page.evaluate(() => {
      return {
        ctrl_c: getControlInput('ctrl_c'),
        ctrl_d: getControlInput('ctrl_d'),
        ctrl_u: getControlInput('ctrl_u'),
        ctrl_k: getControlInput('ctrl_k'),
        ctrl_w: getControlInput('ctrl_w'),
        enter: getControlInput('enter'),
        up: getControlInput('up'),
        down: getControlInput('down')
      };
    });

    const allSequencesValid =
      controlSequences.ctrl_c === '\x03' &&
      controlSequences.ctrl_d === '\x04' &&
      controlSequences.ctrl_u === '\x15' &&
      controlSequences.ctrl_k === '\x0B' &&
      controlSequences.ctrl_w === '\x17' &&
      controlSequences.enter === '\r' &&
      controlSequences.up.includes('\x1b[A') &&
      controlSequences.down.includes('\x1b[B');

    recordTest('控制序列正确', allSequencesValid, JSON.stringify(controlSequences));

    // 输出测试报告
    console.log('\n' + '='.repeat(50));
    log('测试报告');
    console.log('='.repeat(50));
    console.log(`通过：${results.passed}`);
    console.log(`失败：${results.failed}`);
    console.log(`总计：${results.passed + results.failed}`);
    console.log('='.repeat(50));

    if (results.failed > 0) {
      console.log('\n失败的测试:');
      results.tests.filter(t => !t.passed).forEach(t => {
        console.log(`  - ${t.name}: ${t.error}`);
      });
      console.log('\n❌ 测试未通过，请不要发布！');
      process.exit(1);
    } else {
      console.log('\n✅ 所有测试通过，可以发布！');
      process.exit(0);
    }

  } catch (e) {
    log(`测试执行失败：${e.message}`, 'fail');
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// 运行测试
runTests();
