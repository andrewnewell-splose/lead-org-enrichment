// api/enrich-lead-org.js
// Pipedrive lead.added webhook -> domain-based org attach + Lusha enrichment
// Runtime: Vercel Node serverless function (Node 18+, global fetch)

const PIPEDRIVE_BASE = "https://api.pipedrive.com/v1";
const PIPEDRIVE_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const LUSHA_API_KEY = process.env.LUSHA_API_KEY;
const WEBHOOK_USER = process.env.PIPEDRIVE_WEBHOOK_USER;
const WEBHOOK_PASS = process.env.PIPEDRIVE_WEBHOOK_PASSWORD;

// Custom field key (hash) for the canonical company-domain field on the org object.
const ORG_DOMAIN_FIELD_KEY = "c9964d2f56ad36d6c6fd1365884df1ad016dc9d2";

// Org custom field keys written from Lusha enrichment.
const PRACTITIONER_FIELD_KEY = "408445b2332940cc4d813693dbb4f06939ceface"; // number of practitioners (= employee count for our ICP)
const COMPANY_SIZE_FIELD_KEY = "f0131c539cef00aa2f82f31751ac38eeb4a2fb1f"; // banded options field
// website and linkedin are standard org fields, written by their plain keys (no hash).

// Free / personal / ISP domains we never treat as a company.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.com.au", "ymail.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com",
  "bigpond.com", "bigpond.net.au", "optusnet.com.au", "iinet.net.au", "tpg.com.au",
  "internode.on.net", "ozemail.com.au", "westnet.com.au"
]);

function normaliseDomain(email) {
  if (!email || typeof email !== "string") return null;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1].trim().replace(/^www\./, "").replace(/\.$/, "");
  return domain || null;
}

async function pd(path, options = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${PIPEDRIVE_BASE}${path}${sep}api_token=${PIPEDRIVE_TOKEN}`;
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`Pipedrive ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.data;
}

// Exact search of orgs on the canonical domain field, then confirm equality.
async function findOrgByDomain(domain) {
  const data = await pd(
    `/organizations/search?term=${encodeURIComponent(domain)}` +
    `&fields=custom_fields&exact_match=true`
  );
  const items = data?.items || [];
  for (const it of items) {
    const full = await pd(`/organizations/${it.item.id}`);
    if ((full?.[ORG_DOMAIN_FIELD_KEY] || "").toLowerCase() === domain) {
      return full;
    }
  }
  return null;
}

// Lusha V3 company search-and-enrich (POST /v3/companies/search-and-enrich).
// Verified response: results[].name, .employeeCount {exact, min, max}, .socialLinks.linkedin.
// There is no website field in the response, so website is built from the domain in createOrg.
async function enrichCompany(domain) {
  try {
    const res = await fetch("https://api.lusha.com/v3/companies/search-and-enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api_key": LUSHA_API_KEY },
      body: JSON.stringify({ companies: [{ domain }] })
    });
    if (!res.ok) return null;
    const body = await res.json();
    const c = body?.results?.[0];
    if (!c || c.error) return null;
    const ec = c.employeeCount || {};
    const employees = ec.exact ?? ec.max ?? ec.min ?? null;
    return {
      name: c.name ?? null,
      linkedin: c.socialLinks?.linkedin ?? null,
      employees: employees != null ? Number(employees) : null
    };
  } catch {
    return null;
  }
}

// Map an employee count to one of the Company Size option labels (must match Pipedrive exactly).
function bandLabel(count) {
  if (count == null || isNaN(count)) return null;
  const n = Number(count);
  if (n <= 4) return "1 - 4";
  if (n <= 14) return "5 - 14";
  if (n <= 49) return "15 - 49";
  if (n <= 99) return "50 - 99";
  return "100 +";
}

// Resolve a Company Size option label to its numeric option id (Pipedrive sets options by id,
// not label). Field definition is fetched once and cached for the lifetime of the instance.
let _companySizeOptions = null;
async function companySizeOptionId(label) {
  if (!label) return null;
  if (!_companySizeOptions) {
    const fields = await pd(`/organizationFields`);
    const field = (fields || []).find(f => f.key === COMPANY_SIZE_FIELD_KEY);
    _companySizeOptions = field?.options || [];
  }
  const opt = _companySizeOptions.find(o => o.label === label);
  return opt ? opt.id : null;
}

async function createOrg({ domain, statedName, enriched }) {
  const name = enriched?.name || statedName || domain;
  const payload = {
    name,
    [ORG_DOMAIN_FIELD_KEY]: domain,
    website: `https://${domain}`
  };

  if (enriched) {
    const count = enriched.employees;
    if (count != null) payload[PRACTITIONER_FIELD_KEY] = count;

    const optionId = await companySizeOptionId(bandLabel(count));
    if (optionId) payload[COMPANY_SIZE_FIELD_KEY] = optionId;

    if (enriched.linkedin) payload.linkedin = enriched.linkedin;
  }

  return pd(`/organizations`, { method: "POST", body: JSON.stringify(payload) });
}

async function attachOrgToLead(leadId, orgId) {
  return pd(`/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({ organization_id: orgId })
  });
}

// Validate HTTP Basic auth against the configured username/password.
// Enforced only when both are set; leave them unset to accept any POST.
function checkBasicAuth(req) {
  if (!WEBHOOK_USER && !WEBHOOK_PASS) return true;
  const header = req.headers["authorization"] || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  return decoded.slice(0, idx) === WEBHOOK_USER && decoded.slice(idx + 1) === WEBHOOK_PASS;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // 1. Verify HTTP Basic auth (set as username/password on the Pipedrive webhook action).
  if (!checkBasicAuth(req)) return res.status(401).end();

  try {
    // 2. Read the custom payload keys defined in the Pipedrive workflow body.
    const body = req.body || {};
    const leadId = body["lead-id"];
    if (!leadId) return res.status(200).json({ skipped: "no lead id" });

    // 3. Already attached -> nothing to do.
    if (body["org-id"]) return res.status(200).json({ skipped: "org already set" });

    // 4. Resolve domain from the contact email in the payload.
    const domain = normaliseDomain(body["person-email"]);
    if (!domain) return res.status(200).json({ skipped: "no parseable domain" });

    // 5. Blocklist personal / ISP domains (no org, no Lusha credit spent).
    if (FREE_EMAIL_DOMAINS.has(domain)) {
      return res.status(200).json({ skipped: "personal domain", domain });
    }

    // 6. Match existing org.
    let org = await findOrgByDomain(domain);

    // 7. Concurrency guard: re-check before create to NARROW the race.
    //    For real safety, take a short-lived Vercel KV / Upstash lock keyed on the domain.
    if (!org) org = await findOrgByDomain(domain);

    // 8. Genuine miss -> enrich, then create.
    if (!org) {
      const enriched = await enrichCompany(domain);
      const statedName = body["stated-company"];
      org = await createOrg({ domain, statedName, enriched });
    }

    // 9. Attach.
    await attachOrgToLead(leadId, org.id);
    return res.status(200).json({ attached: org.id, domain });
  } catch (err) {
    console.error(err);
    // 200 avoids Pipedrive retry storms on a logic bug you will fix forward.
    // Switch to 500 if you want Pipedrive to retry.
    return res.status(200).json({ error: String(err) });
  }
}
