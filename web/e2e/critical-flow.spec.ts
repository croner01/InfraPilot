import { test, expect } from '@playwright/test'

test('告警中心展示真实告警数据', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '告警中心' })).toBeVisible()
  await expect(page.getByText('order-api Pod CrashLoopBackOff')).toBeVisible()
})

test('新建会话进入会话工作台', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /新建会话/ }).click()
  await expect(page.getByPlaceholder(/描述故障现象或输入指令/)).toBeVisible()
})
