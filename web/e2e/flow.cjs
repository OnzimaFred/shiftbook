// Browser end-to-end test of the whole app, using Playwright and Chromium.
// Needs: a running Shiftbook server (APP_ORIGIN=http://localhost:8099 RP_ID=localhost) on a fresh database
// with sign-ins plant.manager, fred.onzima and moses.masereka whose passwords are Better-<username>-2026,
// and python3 with qrcode and pillow (for the fake camera). Run: node web/e2e/flow.cjs
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const BASE = process.env.BASE ?? "http://localhost:8099";
const DIR = __dirname + "/";
const OUT = DIR + "shots/";
fs.mkdirSync(OUT, { recursive: true });
const pw = (u) => "Better-" + u + "-2026";
let fails = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) fails++; };

async function signIn(browser, u, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, geolocation: { latitude: 0.3501, longitude: 30.0301, accuracy: 10 }, permissions: ["geolocation", "camera"], ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("pageerror", u, e.message); fails++; });
  await page.goto(BASE + "/");
  await page.fill("#u", u); await page.fill("#p", pw(u)); await page.click("button[type=submit]");
  await page.waitForSelector("#view");
  return { ctx, page };
}
const go = async (page, k) => { await page.evaluate((x) => { location.hash = x; }, k); await page.waitForTimeout(800); };
const toast = (page) => page.textContent("#toast");

(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${DIR}qr.mjpeg`] });
  execFileSync("python3", [DIR + "mkqr.py", "placeholder", DIR + "qr.mjpeg"]);

  // ---- 1. PT II (Fred, Nyamwamba 2) starts the November roster, paints a change, submits
  {
    const { ctx, page } = await signIn(browser, "fred.onzima");
    await go(page, "roster");
    await page.click('[data-act="start"]'); await page.waitForTimeout(1200);
    check(/Draft/.test(await page.textContent("#view")), "PT II started the Nyamwamba 2 roster as a draft");
    // paint: put Edinous (crew A, PT) on OFF for a night he works -> should create a blocking problem
    const cells = await page.$$('.cell[data-p][data-d="2026-11-20"]');
    await page.click('[data-act="brush"][data-code="OFF"]');
    // find the PT on night 20 Nov
    const night = await page.evaluate(() => [...document.querySelectorAll('.cell.night[data-d="2026-11-20"]')].map((c) => c.dataset.p));
    await page.click(`.cell[data-p="${night[0]}"][data-d="2026-11-20"]`);
    await page.waitForTimeout(2500);
    const txt = await page.textContent("#view");
    check(/problem/.test(txt) && await page.isDisabled('[data-act="submit"]'), "Taking someone off a night blocks submitting");
    await page.screenshot({ path: OUT + "flow-roster-problem.png" });
    // book cover from the cheapest option
    const assign = await page.$('[data-act="assign"]');
    check(!!assign, "Cover options are offered for the gap");
    if (assign) { await assign.click(); await page.waitForTimeout(1500); console.log("   ", await toast(page)); }
    const ok = !(await page.isDisabled('[data-act="submit"]'));
    check(ok, "After cover is booked the roster can be submitted");
    if (ok) { await page.click('[data-act="submit"]'); await page.waitForTimeout(1200); }
    check(/Waiting for approval/.test(await page.textContent("#view")), "Roster submitted");
    // copy for excel text
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click('[data-act="copy"]'); await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    check(/POWER HOUSE DUTY SCHEDULE/.test(clip) && clip.split("\n").length > 12, "Copy for Excel produces the duty-schedule layout");
    fs.writeFileSync(OUT + "excel.tsv", clip);
    // set a kiosk PIN for Fred
    await go(page, "settings");
    await page.fill("#pin1", "4826"); await page.fill("#pin2", "4826"); await page.click("#pinf button[type=submit]"); await page.waitForTimeout(600);
    check(/PIN saved/.test(await toast(page)), "PT II set a control-room PIN");
    await ctx.close();
  }

  // ---- 2. Manager approves the roster
  let kioskCreds;
  {
    const { ctx, page } = await signIn(browser, "plant.manager");
    await go(page, "approvals");
    check(/Nyamwamba 2 HPP, November 2026/.test(await page.textContent("#view")), "Manager sees the submitted roster in Approvals");
    await page.click('[data-act="openRoster"]'); await page.waitForTimeout(1200);
    await page.click('[data-act="approve"]'); await page.waitForTimeout(1200);
    check(/Approved and published/.test(await page.textContent("#view")), "Manager approved the Nyamwamba 2 roster");
    await page.screenshot({ path: OUT + "flow-roster-approved.png" });
    // register this browser as the Nyamwamba 2 control-room phone
    await go(page, "settings");
    await page.selectOption("#kp", "n2");
    await page.click('[data-act="registerKiosk"]'); await page.waitForTimeout(1500);
    kioskCreds = await page.evaluate(() => localStorage.getItem("shiftbook_kiosk"));
    check(!!kioskCreds && /n2/.test(kioskCreds), "Control-room phone registered and its codes stored on it");
    await page.waitForSelector("#kq svg", { timeout: 5000 });
    const code = await page.getAttribute("#kq", "data-code");
    check(/^SB1\./.test(code), "Kiosk shows a rotating clock-in code");
    await page.screenshot({ path: OUT + "flow-kiosk-qr.png" });
    await ctx.close();
  }

  // ---- 3. Fred: set up fingerprint (virtual authenticator), manager approves, then QR clock-in via fake camera
  const creds = JSON.parse(kioskCreds);
  {
    const { ctx, page } = await signIn(browser, "fred.onzima");
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await go(page, "settings");
    await page.click('[data-act="setupPhone"]'); await page.waitForTimeout(2000);
    check(/approve/i.test(await toast(page)), "Fingerprint set up on Fred's phone, waiting for approval");
    await go(page, "today");
    await page.click('[data-act="clock"]'); await page.waitForTimeout(1500);
    check(/Waiting for approval/.test(await page.textContent(".dialog")), "Clock-in refused until the phone is approved");
    await page.keyboard.press("Escape");

    const m = await signIn(browser, "plant.manager");
    await go(m.page, "approvals");
    check(/Fred Onzima/.test(await m.page.textContent("#view")), "Manager sees Fred's new phone");
    await m.page.click('[data-act="approvePhone"]'); await m.page.waitForTimeout(800);
    await m.ctx.close();

    const text = execFileSync("node", ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(require("path").resolve(__dirname, "../../api/src/clockcore.ts"))}); process.stdout.write(await m.qrPayload(${JSON.stringify(creds.deviceId)}, new Uint8Array(Buffer.from(${JSON.stringify(creds.qrSecret)}, "base64url")), m.qrWindow(Date.now())))`]).toString();
    execFileSync("python3", [DIR + "mkqr.py", text, DIR + "qr.mjpeg"]);
    await go(page, "today");
    await page.click('[data-act="clock"]');
    await page.waitForFunction(() => /Clocked in|didn't work/.test(document.querySelector(".dialog")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
    await page.screenshot({ path: OUT + "flow-phone-clockin.png" });
    const res = (await page.$(".dialog")) ? await page.textContent(".dialog") : "no dialog; toast: " + await toast(page);
    console.log("   ", res.replace(/\s+/g, " ").trim().slice(0, 200));
    check(/Clocked in/.test(res), "Fred clocked in by scanning the kiosk code and fingerprint");
    await page.screenshot({ path: OUT + "flow-phone-clockin.png" });
    await page.click('.dialog [data-act="close"]'); await page.waitForTimeout(1000);
    check(/Clock out/.test(await page.textContent(".punch")), "Today screen now offers Clock out");
    // a replayed (old) code must be refused
    await ctx.close();
  }

  // ---- 4. Kiosk: Fred has no phone today; clocks out with his PIN and a photo
  {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, permissions: ["camera"] });
    await ctx.addInitScript((c) => localStorage.setItem("shiftbook_kiosk", c), kioskCreds);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { console.log("pageerror kiosk", e.message); fails++; });
    await page.goto(BASE + "/#kiosk");
    await page.waitForSelector("#kq svg");
    await page.click('[data-act="nophone"]');
    await page.waitForSelector(".namegrid button");
    await page.screenshot({ path: OUT + "flow-kiosk-names.png" });
    await page.click('.namegrid button:has-text("Fred Onzima")');
    await page.click('[data-kind="out"]');
    // wrong PIN first
    for (const k of "1111") await page.click(`[data-k="${k}"]`);
    await page.click('[data-k="ok"]');
    await page.waitForSelector('[data-act="send"]', { timeout: 15000 });
    await page.click('[data-act="send"]'); await page.waitForTimeout(1200);
    check(/PIN isn't right/.test(await page.textContent(".kiosk")), "Kiosk refuses a wrong PIN");
    await page.click('[data-act="back"]');
    await page.click('[data-act="nophone"]'); await page.waitForSelector(".namegrid button");
    await page.click('.namegrid button:has-text("Fred Onzima")');
    await page.click('[data-kind="out"]');
    for (const k of "4826") await page.click(`[data-k="${k}"]`);
    await page.click('[data-k="ok"]');
    await page.waitForSelector('[data-act="send"]', { timeout: 15000 });
    await page.screenshot({ path: OUT + "flow-kiosk-photo.png" });
    await page.click('[data-act="send"]'); await page.waitForTimeout(1500);
    const t = await page.textContent(".kiosk");
    console.log("   ", t.replace(/\s+/g, " ").trim().slice(0, 200));
    check(/clocked out/.test(t), "Fred clocked out on the kiosk with PIN and photo");
    await page.screenshot({ path: OUT + "flow-kiosk-done.png" });
    await ctx.close();
  }

  // ---- 5. Manager: exceptions show the kiosk photo; mark sick and book cover on Team
  {
    const { ctx, page } = await signIn(browser, "plant.manager");
    await go(page, "exceptions");
    const ex = await page.textContent("#view");
    check(/Fred Onzima/.test(ex), "Exceptions lists Fred's flagged clock-ins");
    const img = await page.$(".photo-thumb");
    check(!!img && await img.evaluate((i) => i.complete && i.naturalWidth > 0), "Kiosk photo loads for the manager");
    await page.screenshot({ path: OUT + "flow-exceptions.png" });
    await go(page, "timesheet");
    await page.selectOption("#who", { label: "Fred Onzima" }); await page.waitForTimeout(1000);
    console.log("   ", (await page.textContent("#view table")).replace(/\s+/g, " ").slice(0, 600));
    check(/Own phone/.test(await page.textContent("#view")) && /Control-room phone/.test(await page.textContent("#view")), "Timesheet pairs the phone clock-in and kiosk clock-out");
    await page.screenshot({ path: OUT + "flow-timesheet.png" });
    await go(page, "team");
    const sick = await page.$$('[data-act="sick"][data-plant="n2"][data-shift="N"]');
    await sick[0].click(); await page.waitForTimeout(400);
    await page.click('[data-act="saveSick"]'); await page.waitForTimeout(1500);
    const dlg = (await page.$(".dialog")) ? await page.textContent(".dialog") : "toast: " + await toast(page);
    console.log("   ", dlg.replace(/\s+/g, " ").slice(0, 300));
    check(/Cover the night shift/.test(dlg), "Marking someone sick on a night opens cover options");
    await page.screenshot({ path: OUT + "flow-cover.png" });
    if (await page.$('[data-act="book"]')) { await page.click('[data-act="book"]'); await page.waitForTimeout(1500); }
    const after = await page.textContent("#view");
    check(/Cover, overtime/.test(after), "Cover booked and shown on Team today");
    await page.screenshot({ path: OUT + "flow-team-after.png" });
    // staff screen: create a sign-in
    await go(page, "staff");
    await page.click('tr:has-text("Lilian Tumusiime") [data-act="signin"]');
    await page.click('#sf button[type=submit]'); await page.waitForTimeout(800);
    check(/Temporary password/.test(await page.textContent(".dialog")), "Manager created a sign-in and sees the temporary password");
    await page.screenshot({ path: OUT + "flow-staff-signin.png" });
    await ctx.close();
  }

  // ---- 6. Phone-size layout
  {
    const { ctx, page } = await signIn(browser, "moses.masereka", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.screenshot({ path: OUT + "mobile-today.png" });
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check(w <= 390, "No sideways scrolling on a phone (" + w + "px)");
    await go(page, "roster"); await page.screenshot({ path: OUT + "mobile-roster.png" });
    await ctx.close();
  }
  console.log(fails ? `---- ${fails} failed` : "---- all passed");
  await browser.close();
})();
