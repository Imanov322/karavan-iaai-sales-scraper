# karavan-iaai-sales-scraper

HTTP microservice for the Karavan Office Sales module. Logs into IAAI on demand,
finds a won vehicle by **lot number** + **win date** + **buyer account**, and
returns the parsed vehicle description, telegram-formatted text, and image URLs.

Triggered manually by the office backend's `POST /sales/:id/fetch-auction`
endpoint when a sales manager clicks "Fetch from IAAI" on a listing.

## API

### `POST /scrape`

Headers:
- `x-api-key: <API_KEY>` (required if `API_KEY` is set)
- `Content-Type: application/json`

Body:
```json
{
  "lotNumber": "12345678",
  "winDate": "2026-03-16",
  "account": "khorasan"
}
```

`account` is case-insensitive and maps to `IAAI_<UPPERCASE>_USER` / `IAAI_<UPPERCASE>_PASS` env vars (e.g. `khorasan` → `IAAI_KHORASAN_USER`).

Response (200):
```json
{
  "data": {
    "make": "AUDI",
    "model": "Q5 PRESTIGE 45",
    "vin": "WA1FAAFY9N2...",
    "year": "2022",
    "engine": "...",
    "mileage": "...",
    "damage": "...",
    "...": "..."
  },
  "telegramDescription": "<b>Karavan Motors</b>\n...",
  "imageUrls": [
    "https://anvis.iaai.com/.../resizer/...&width=640&height=480",
    "..."
  ]
}
```

## Local development

```bash
cp .env.example .env
# fill in IAAI_*_USER / IAAI_*_PASS for at least one account
npm install
HEADFUL=true npm start
```

`HEADFUL=true` shows the Chrome window — useful for debugging selectors when
IAAI changes their markup.

Test request:
```bash
curl -X POST http://localhost:4100/scrape \
  -H "x-api-key: change-me" \
  -H "Content-Type: application/json" \
  -d '{"lotNumber":"12345678","winDate":"2026-03-16","account":"khorasan"}'
```

## Railway deploy

1. Push this directory to its own GitHub repo (or a sub-path) and connect it to
   a new Railway service.
2. Railway auto-detects the Dockerfile and builds. No `nixpacks` needed.
3. Set service env vars in Railway:
   - `API_KEY` — same value as `IAAI_SCRAPER_API_KEY` on the office backend.
   - `IAAI_<NAME>_USER` and `IAAI_<NAME>_PASS` for every buyer account you
     want to support.
4. Get the public URL Railway assigns and set it as `IAAI_SCRAPER_URL` on the
   office backend (no trailing slash).

The Dockerfile uses Debian Chromium (`/usr/bin/chromium`) and the headless
"new" mode. One scrape at a time is enforced server-side because IAAI sessions
don't like parallel logins from the same buyer account.

## Notes / limitations

- IAAI's "Purchase History" grid is the source of truth. If a lot doesn't
  appear there for the given `winDate`, the scrape fails with
  `Lot ... not found in purchase history`.
- Buyer accounts often have multiple tenant tabs (different licensee
  branches). The scraper iterates all of them and uses the first one
  containing the matching lot.
- Vehicle data is preferentially parsed from the `#VehicleDetailsVM` JSON
  blob; a legacy DOM-scrape fallback is in place for older lot pages.
- Image URLs come from `ThumbNailUrllst`, rewritten from `thumbnail` to
  `resizer` with `width=640&height=480`. The office backend stores these
  URLs verbatim as AUCTION-type Document rows (no re-upload to Appwrite).
