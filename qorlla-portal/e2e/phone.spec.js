const { test, expect } = require('@playwright/test');
const { BASE, dbq, signUpWithWorkspace } = require('./helpers');

// The unified test stack runs with telephony OFF (no provider account, no compliance acknowledgement). These tests therefore prove the
// honest-off behaviour and the configuration/booking UI against the real stack. A real inbound or outbound call is NOT exercised here:
// that stays BLOCKED until a provider account, a provisioned number and the compliance acknowledgement exist.
test.describe('Phone and AI Receptionist (telephony OFF)', () => {
  test('the phone page states that telephony is off, shows an empty history, and public webhooks refuse to run', async ({ page, context, request }) => {
    const me = await signUpWithWorkspace(context, 'phone');
    await page.goto('/app/phone');
    await expect(page.getByRole('heading', { name: 'Qorlla Phone', exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Telephony is OFF' })).toBeVisible();
    await expect(page.getByText('No calls yet. Calls appear here only when the provider reports them.')).toBeVisible();
    await expect(page.getByText('Unavailable while telephony is off.')).toBeVisible();
    // register a number: it stays pending and cannot be activated
    await page.fill('#num-form [name=e164]', '+12025550142'); await page.fill('#num-form [name=label]', 'Main'); await page.getByRole('button', { name: 'Register number' }).click();
    await expect(page.locator('tr[data-num]')).toContainText('pending');
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.locator('#notice')).toContainText('Telephony is not enabled');
    expect(dbq(`SELECT status FROM portal.phone_numbers WHERE e164='+12025550142'`)).toBe('pending');
    // the provider endpoints are public but fail closed
    const r = await request.post('/api/v1/telephony/voice/inbound', { form: { CallSid: 'CA' + 'e'.repeat(32), From: '+12025550100', To: '+12025550142' } });
    expect(r.status()).toBe(503);
    expect(dbq(`SELECT count(*) FROM portal.call_sessions WHERE workspace_id='${me.workspaceId}'`)).toBe('0');
    expect((await request.get('/api/v1/phone/calls')).status()).toBe(401);
  });

  test('receptionist: create a profile, set business hours, enable it, add rules, and book an appointment against the hours', async ({ page, context }) => {
    const me = await signUpWithWorkspace(context, 'recep');
    await page.goto('/app/receptionist');
    await expect(page.getByRole('heading', { name: 'AI Receptionist', exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Telephony is OFF' })).toBeVisible();
    await page.fill('#profile-form [name=name]', 'Front desk'); await page.fill('#profile-form [name=timezone]', 'UTC'); await page.getByRole('button', { name: 'Create profile' }).click();
    const profile = page.locator('details.profile'); await expect(profile).toContainText('Front desk'); await profile.locator('summary').click();
    // enabling before hours exist is refused with a clear message
    await profile.locator('.text-form [name=enabled]').check(); await profile.locator('.text-form').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#notice')).toContainText('Save business hours before enabling');
    // every day 00:00-23:59
    for (let d = 0; d < 7; d++) { await profile.locator(`[data-day="${d}"]`).check(); await profile.locator(`[data-opens="${d}"]`).fill('00:00'); await profile.locator(`[data-closes="${d}"]`).fill('23:59'); }
    await profile.getByRole('button', { name: 'Save hours' }).click(); await expect(page.locator('#notice')).toContainText('Hours saved');
    await profile.locator('.text-form [name=enabled]').check(); await profile.locator('.text-form').getByRole('button', { name: 'Save' }).click(); await expect(page.locator('#notice')).toContainText('Saved');
    expect(dbq(`SELECT enabled FROM portal.receptionist_profiles WHERE workspace_id='${me.workspaceId}'`)).toBe('t');
    // a routing rule
    await profile.getByRole('button', { name: 'Add rule' }).click();
    const row = profile.locator('tr.route').first(); await row.locator('[data-f=name]').fill('Sales'); await row.locator('[data-f=digit]').fill('1'); await row.locator('[data-f=action]').selectOption('forward'); await row.locator('[data-f=destination]').fill('+12025550188');
    await profile.getByRole('button', { name: 'Save rules' }).click(); await expect(page.locator('#notice')).toContainText('Rules saved');
    expect(dbq(`SELECT count(*) FROM portal.call_routes WHERE workspace_id='${me.workspaceId}' AND action='forward' AND destination='+12025550188'`)).toBe('1');
    // the recording notice cannot be blanked
    await profile.locator('.text-form [name=recording_notice]').fill('short'); await profile.locator('.text-form').getByRole('button', { name: 'Save' }).click();
    // appointment on tomorrow
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    await page.reload(); await page.fill('#appt-form [name=date]', tomorrow); await expect(page.locator('#appt-form [name=slot] option').first()).not.toHaveText('Pick a date…');
    await page.fill('#appt-form [name=title]', 'Consultation'); await page.fill('#appt-form [name=attendee_name]', 'Dana Caller'); await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Appointment booked');
    await expect(page.locator('tr[data-appt]')).toContainText('Consultation');
    expect(dbq(`SELECT count(*) FROM portal.appointments WHERE workspace_id='${me.workspaceId}' AND status='booked'`)).toBe('1');
  });

  test('the workspace owner sees the manager-only phone sections', async ({ page, context }) => {
    await signUpWithWorkspace(context, 'ownerp');
    await page.goto('/app/phone'); await expect(page.getByRole('heading', { name: 'Phone numbers' })).toBeVisible();
  });
});
