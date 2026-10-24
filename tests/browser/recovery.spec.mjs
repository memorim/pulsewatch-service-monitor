import {test,expect} from '@playwright/test';
test('mobile layout and recovery after a failed API request',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();await expect(page.locator('.load-feedback')).toHaveText('');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2)).toBe(true);
 await page.route('**/api/overview*',r=>r.fulfill({status:503,contentType:'application/json',body:'{"message":"Test unavailable"}'}));
 await page.reload();await expect(page.getByRole('button',{name:'Повторить загрузку',exact:true})).toBeVisible();
 await page.unroute('**/api/overview*');await page.getByRole('button',{name:'Повторить загрузку',exact:true}).click();
 await expect(page.locator('.load-feedback')).toHaveText('');
});

test('failed form submission retains entered data',async({page})=>{
 await page.goto('/');await page.locator(".add").first().click();const form=page.locator("#monitor-form");await expect(form).toBeVisible();
 const values={"name": "Browser demo monitor", "url": "https://example.com"};for(const [name,value] of Object.entries(values))await form.locator('[name="'+name+'"]').fill(value);
 await page.route('**/api/**',route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
 await form.locator('button').last().click();await expect(form.getByRole('alert')).toContainText('Не удалось выполнить запрос');
 await expect(form.locator('[name="name"]')).toHaveValue(values["name"]);
});
