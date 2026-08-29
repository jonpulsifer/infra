-- kthx `db`: one JSON value per key, per site (`src/kthx/data.ts`).
--
-- Anyone on a site's origin writes here, artifacts-style. `etag` is the
-- SHA-256 of the value's canonical JSON, quoted, so a `PUT` with `if-match`
-- is a compare-and-swap the row itself decides.
CREATE TABLE "kthx_kv" (
	"site" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"etag" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kthx_kv_site_key_pk" PRIMARY KEY("site","key"),
	CONSTRAINT "kthx_kv_site_kthx_sites_name_fk" FOREIGN KEY ("site") REFERENCES "public"."kthx_sites"("name") ON DELETE cascade ON UPDATE no action
);
