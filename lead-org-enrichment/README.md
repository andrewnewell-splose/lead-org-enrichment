# Lead to org enrichment

A Pipedrive workflow webhook that runs on lead creation. It parses the company domain
from the contact email, attaches an existing organization if one matches on the canonical
domain field, or enriches via Lusha and creates the org before attaching it to the lead.

The webhook is the trigger (Pipedrive pushes the lead to this function). The Pipedrive API
calls inside the function do the work the webhook cannot: search org records, create an org,
and patch the lead. GitHub hosts the source; Vercel runs it.

## Flow

1. Gate the request: POST only, valid HTTP Basic credentials, lead id present.
2. Exit if the lead already has an org attached.
3. Resolve the email from the payload, normalise it to a bare domain.
4. Skip personal and ISP domains (no org created, no Lusha credit spent).
5. Search organizations on the canonical domain field, exact match, then confirm equality.
   Where one domain has several orgs, prefer the one carrying a Stripe customer id (the
   billing record), then the newest.
6. On a miss, re-check once to narrow the concurrency window, then enrich via Lusha and create.
7. Patch the lead to attach the org, then link the lead's person to it unless that person
   already has an org. Return 200.

## Environment variables

Set these in the Vercel project (Settings, Environment Variables). See `.env.example`.

- `PIPEDRIVE_API_TOKEN` Pipedrive API token used for org search, org create, and lead patch.
- `LUSHA_API_KEY` Lusha API key used for company enrichment by domain.
- `PIPEDRIVE_WEBHOOK_USER` and `PIPEDRIVE_WEBHOOK_PASSWORD` HTTP Basic auth credentials. Must match
  the HTTP Auth username and password set on the Pipedrive webhook action, or the function returns
  401. Leave both unset to disable the check.

## Field mapping

Read, never written: `45c5d808a061abe5f06f73b97f7f4ae8d1ca7e7a` (Stripe customer id,
maintained by the stripe_metadata sync in splose-revops) breaks duplicate-domain ties.

Written onto the org on create:

- `name` (standard) from the Lusha company name, falling back to the stated company name, then the domain.
- `c9964d2f56ad36d6c6fd1365884df1ad016dc9d2` (domain) from the parsed email domain.
- `408445b2332940cc4d813693dbb4f06939ceface` (number of practitioners) from the Lusha employee count.
- `f0131c539cef00aa2f82f31751ac38eeb4a2fb1f` (Company Size) from the employee count banded into the
  options 1 - 4, 5 - 14, 15 - 49, 50 - 99, 100 +, resolved to the option id at runtime.
- `website` (standard) built as `https://` + the domain (Lusha returns no website field).
- `linkedin` (standard) from Lusha `socialLinks.linkedin`.

Stated company name arrives in the payload as `stated-company`, so no hash is needed for it.

## Response

Always 200, so a logic bug cannot start a Pipedrive retry storm. The body says what happened:

```json
{ "attached": 102044, "domain": "sacid.org.au", "action": "created",
  "enriched": true, "personLink": "linked" }
```

- `action` `matched` (an existing org carried the domain) or `created`.
- `enriched` whether Lusha returned a company for the domain. Only ever true on `created`.
- `personLink` `linked`, `already-linked` (the person was already on an org, left alone),
  `no-person` (the payload carried no `person-id`), or `failed` (logged to Vercel, and the
  lead attach still stands). A skip or an error returns `{ "skipped": ... }` / `{ "error": ... }`.

## Pipedrive API versions

This function speaks v1. The verbs differ per resource and the mismatch fails silently
inside a try/catch, so check before adding a call:

| Resource | Update verb |
|---|---|
| `/leads/{id}` | `PATCH` |
| `/persons/{id}` | `PUT` |
| `/organizations/{id}` | `PUT` |

`PATCH` on a person is the **v2** spelling. It returns an error on v1, which is how the
person-org link sat broken from 23 Jun to 26 Aug 2026 without anyone noticing.

## The personal-domain blocklist

`FREE_EMAIL_DOMAINS` stops an org being created (and a Lusha credit spent) for a signup on a
consumer mailbox. It is a hand-maintained list, so it lags: `sky.com`, `hotmail.com.au` and
`myyahoo.com` have all reached production as org records with the consumer domain in the
canonical domain field. Add a domain here when one shows up as an org name in Pipedrive.

## Pipedrive workflow configuration

Trigger: lead created.

HTTP request action:
- Method: POST
- URL: the deployed Vercel URL plus the route, for example
  `https://<your-app>.vercel.app/api/enrich-lead-org`
- HTTP Auth username and password set to the same values as `PIPEDRIVE_WEBHOOK_USER` and
  `PIPEDRIVE_WEBHOOK_PASSWORD`
- Body keys:
  - `lead-id` Lead ID
  - `person-id` Linked person ID (used to link the person to the org)
  - `org-id` Linked organisation ID
  - `stated-company` Stated company name
  - `person-email` Lead contact person email

Confirm the builder sends an empty string (or omits the key) when a field is blank, not the
literal text "null" or a placeholder, so the empty checks branch correctly.

## Deploy

Connect this repo to Vercel and it deploys on push to main. Functions under `api/` are detected
automatically; no `vercel.json` is required.

## Lusha enrichment

Uses Lusha V3 `POST /v3/companies/search-and-enrich` with body `{ companies: [{ domain }] }`,
authenticated with the `api_key` header. The base firmographics used here (`name`,
`employeeCount.exact`, `socialLinks.linkedin`) come back without any `reveal` fields.
Each successful enrichment consumes Lusha credits, and only runs on the create path (a domain
with no existing org match), so credit use is bounded to genuinely new companies.
