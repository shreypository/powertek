# Powertek — Contact Form Backend Setup

The website is still a plain static site. The only backend is one Vercel
serverless function at `api/contact.js`, which the contact form posts to:

```
Contact form (index.html)
        │  POST /api/contact   (JSON)
        ▼
Vercel serverless function
        ├── Resend        → notification email to your Gmail
        └── Google Sheets → one new row in the enquiry log
```

No API keys or credentials exist anywhere in the browser. Everything below is
configured once as environment variables.

---

## 1. Resend — the email service

### 1.1 Get an API key

1. Create a free account at <https://resend.com>.
2. Go to **API Keys** → **Create API Key**.
3. Give it *Sending access* and copy the value — it starts with `re_`.
   Resend shows it **once**, so paste it somewhere safe immediately.

This value becomes `RESEND_API_KEY`.

### 1.2 Verify a sending domain

Resend will not deliver mail from an address you do not control.

1. Go to **Domains** → **Add Domain** and enter a domain you own
   (e.g. `powertek.co.in`).
2. Add the DNS records Resend shows you (SPF/DKIM) at your domain registrar.
3. Wait for the status to turn **Verified**.

> **No domain yet?** For testing only, Resend allows the shared sender
> `onboarding@resend.dev`, but it can only deliver to the email address that
> owns the Resend account. Use a verified domain for production.

### 1.3 What the two email variables mean

| Variable | Meaning |
| --- | --- |
| `CONTACT_TO_EMAIL` | **Where enquiries land.** Your Gmail address, e.g. `powertek.elec@gmail.com`. Comma-separate for several recipients: `a@x.com,b@y.com` |
| `CONTACT_FROM_EMAIL` | **Who the email appears to be from.** Must be on the domain you verified in step 1.2. A display name is optional: `Powertek Website <enquiries@powertek.co.in>` |

The visitor's own address is set as **Reply-To**, so hitting *Reply* in Gmail
answers the visitor directly.

---

## 2. Google Sheets — the enquiry log

### 2.1 Create the sheet

1. Go to <https://sheets.google.com> and create a new spreadsheet.
2. Name it something like `Powertek — Website Enquiries`.
3. Copy the ID out of the URL:

```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit
                                       └──────────── this is GOOGLE_SHEET_ID ────────────┘
```

### 2.2 Columns

Row 1 is the header row and is never overwritten. Put these five headers in
`A1:E1`, in this order:

| A | B | C | D | E |
| --- | --- | --- | --- | --- |
| Timestamp | Name | Email | Phone | Message |

> If you leave the sheet completely empty, the function writes this header row
> for you the first time an enquiry arrives. If row 1 already contains anything,
> it is left exactly as you set it up.

> **Why no "Company" column?** The live contact form collects name, email, phone
> and project details only — there is no company input, so a Company column
> would be permanently blank. If you add a company field to the form later, see
> the note at the top of `api/contact.js` for the three lines to change.

Leave the tab named **Sheet1**. If you rename it, set the optional
`GOOGLE_SHEET_TAB` variable to the new name.

### 2.3 Create a Google Cloud project and enable the Sheets API

1. Go to <https://console.cloud.google.com>.
2. Create a project (e.g. `powertek-website`) or select an existing one.
3. Go to **APIs & Services → Library**.
4. Search for **Google Sheets API** and click **Enable**.

### 2.4 Create a service account

1. Go to **APIs & Services → Credentials**.
2. **Create Credentials → Service account**.
3. Name it e.g. `powertek-sheets-writer`, click **Create and Continue**.
4. You can skip the optional role and user steps — the service account needs no
   project-level role, only access to the one spreadsheet. Click **Done**.
5. Copy its email address, which looks like:

```
powertek-sheets-writer@powertek-website.iam.gserviceaccount.com
```

This value becomes `GOOGLE_SERVICE_ACCOUNT_EMAIL`.

### 2.5 Get the private key

1. Click the service account → **Keys** tab.
2. **Add Key → Create new key → JSON → Create**.
3. A `.json` file downloads. Open it in a text editor. It contains:

```json
{
  "type": "service_account",
  "client_email": "powertek-sheets-writer@....iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----\n"
}
```

4. The full string in `"private_key"` — **including** the
   `-----BEGIN PRIVATE KEY-----` header, the `\n` sequences and the
   `-----END PRIVATE KEY-----` footer — becomes `GOOGLE_PRIVATE_KEY`.

> ⚠️ Treat this JSON file like a password. Do not commit it, do not email it,
> and do not put it anywhere inside this repository. `.gitignore` already blocks
> `*.json` service-account files, `*.pem` and `*.key`, but the safest place for
> it is outside the project folder entirely. Delete the downloaded file once the
> value is in Vercel.

### 2.6 Share the sheet with the service account

**This is the step people forget.** The service account is a separate identity
and cannot see your sheet until you share it.

1. Open the spreadsheet.
2. Click **Share**.
3. Paste the service account email from step 2.4.
4. Set the role to **Editor**.
5. Untick *Notify people* (it is not a real inbox) and click **Share**.

---

## 3. Environment variables

### 3.1 The full list

| Variable | Required | What it is |
| --- | --- | --- |
| `RESEND_API_KEY` | ✅ Yes | Resend API key (`re_…`) |
| `CONTACT_TO_EMAIL` | ✅ Yes | Gmail address that receives enquiries |
| `CONTACT_FROM_EMAIL` | ✅ Yes | Verified Resend sender address |
| `GOOGLE_SHEET_ID` | ✅ Yes | ID from the spreadsheet URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ Yes | `…iam.gserviceaccount.com` address |
| `GOOGLE_PRIVATE_KEY` | ✅ Yes | `private_key` from the service-account JSON |
| `GOOGLE_SHEET_TAB` | Optional | Tab name inside the spreadsheet. Defaults to `Sheet1`. Only needed if you rename the tab. |
| `CONTACT_TIMEZONE` | Optional | IANA timezone for the Timestamp column and the email. Defaults to `Asia/Kolkata`. Without it, Vercel functions would log everything in UTC. |

All six required variables must be present in **Production**. Set them in
**Preview** too if you want the form to work on preview deployments.

### 3.2 Adding them in Vercel

1. Open your project at <https://vercel.com>.
2. **Settings → Environment Variables**.
3. For each variable: type the **Key**, paste the **Value**, tick the
   environments (**Production**, **Preview**, **Development**), click **Save**.

**Pasting `GOOGLE_PRIVATE_KEY`:** paste the value exactly as it appears inside
the quotes in the JSON file, i.e. one long line containing literal `\n`
sequences. The function converts those back into real newlines, and also
tolerates the key being pasted with surrounding quotes or with real line breaks
— all three forms work.

4. **Environment variables only apply to new deployments.** After saving, go to
   **Deployments → ⋯ → Redeploy** on the latest deployment.

### 3.3 Project settings

This repo has no build step. In **Settings → General**, the project should be:

- **Framework Preset:** Other
- **Build Command:** empty (or *Override* off)
- **Output Directory:** empty — `index.html` is served straight from the repo root
- **Install Command:** default (`npm install`) so the API's two dependencies are installed

`api/contact.js` is picked up automatically as a serverless function at
`/api/contact` — that is Vercel's built-in convention, no configuration needed.

---

## 4. Testing

### 4.1 Locally

```bash
npm install
npm i -g vercel      # once
vercel login
vercel env pull .env.local   # or hand-write .env.local from .env.example
vercel dev
```

Open <http://localhost:3000>, scroll to **Contact**, and submit the form.

To hit the endpoint directly without the UI:

```bash
curl -i -X POST http://localhost:3000/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"you@example.com","phone":"+91 90000 00000","message":"Local test"}'
```

Expected responses:

| Situation | Status | Body |
| --- | --- | --- |
| Everything worked | `200` | `{"success":true,"message":"Your enquiry has been submitted successfully."}` |
| Email sent, sheet failed | `200` | `{"success":true,"partial":true,…,"reference":"…"}` |
| Email failed | `502` | `{"success":false,"message":"We couldn't submit…","reference":"…"}` |
| Missing/invalid fields | `400` | `{"success":false,…,"errors":{…}}` |
| Not JSON | `415` | `{"success":false,…}` |
| Not POST | `405` | `{"success":false,"message":"Method not allowed."}` |
| More than 5 posts in 10 min | `429` | `{"success":false,…}` |

### 4.2 After deploying

```bash
curl -i -X POST https://YOUR-DOMAIN.vercel.app/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Deploy Test","email":"you@example.com","message":"Checking production"}'
```

Then submit the real form on the live site once.

### 4.3 Verifying both destinations

**Email:**
1. Check the inbox of `CONTACT_TO_EMAIL` (check Spam on the first send).
2. The subject is `New Website Enquiry — Powertek`.
3. Click *Reply* — it should address the visitor's email, not your own.

**Sheet:**
1. Open the spreadsheet.
2. A new row should sit directly below the last one, with the timestamp in your
   configured timezone.
3. Nothing above it should have changed — rows are only ever appended.

**If one of them is missing**, open **Vercel → your project → Logs**, filter for
`[contact:` and find the reference id from the response. Common causes:

| Log message contains | Fix |
| --- | --- |
| `Resend is not configured` | One of the three Resend variables is missing — check spelling, then redeploy |
| `domain is not verified` | Finish domain verification in Resend, or change `CONTACT_FROM_EMAIL` |
| `The caller does not have permission` | The sheet was not shared with the service account (step 2.6) |
| `Google Sheets API has not been used` | The Sheets API is not enabled on the project (step 2.3) |
| `invalid_grant` / `error:1E08010C` | `GOOGLE_PRIVATE_KEY` is truncated or malformed — re-paste the whole value |
| `Unable to parse range` | `GOOGLE_SHEET_TAB` does not match the actual tab name |

---

## 5. What happens when something fails

The endpoint never claims more than actually happened:

| Resend | Sheets | Response | Why |
| --- | --- | --- | --- |
| ✅ | ✅ | `200 success:true` | Fully processed |
| ✅ | ❌ | `200 success:true, partial:true` | You *did* get the email, so telling the visitor it failed would only produce duplicate enquiries. The message says the enquiry reached the team — not that it was fully recorded — and the miss is logged with a reference id so the row can be added by hand |
| ❌ | ✅ | `502 success:false` | Nobody was notified, so the visitor is told plainly that it did not go through |
| ❌ | ❌ | `502 success:false` | Nothing happened |

The two calls run in parallel, so one provider being down never blocks the
other. Provider error messages, stack traces and credentials are **never** sent
to the browser — only the generic message plus a reference id that matches the
server log.

---

## 6. Security notes

- No secret appears in `index.html`, `support.js` or any client-side code. The
  browser only ever calls `/api/contact` on its own origin.
- `.env`, `.env.local`, `.vercel`, `*.pem`, `*.key` and service-account JSON
  files are all git-ignored.
- The endpoint validates and length-limits every field server-side, rejects
  bodies over 20 KB, requires a JSON content type, strips control characters
  (so the visitor's email cannot inject mail headers), and HTML-escapes
  everything it puts into the email.
- Sheet values are written with `valueInputOption=RAW`, so a message beginning
  with `=` is stored as text and never evaluated as a spreadsheet formula.
- A hidden honeypot field plus a per-IP throttle (5 submissions per 10 minutes)
  handle casual spam. The throttle lives in the function's memory, so it resets
  when Vercel starts a new instance — it is a speed bump, not a guarantee. If
  spam ever becomes a real problem, that is the point to add Vercel KV or
  a CAPTCHA; neither is needed today.
