-- kthx sites: a name, the hash of the bearer that owns it, and which release
-- it serves (`src/kthx/`).
--
-- A site is not an App. Its releases are staged bundles in the same depot an
-- uploaded artifact lands in, and `serving` points at one of them by number
-- rather than through a Build or a Deploy: the whole product is "which bytes
-- answer for this name", and that is one integer.
--
-- `held` is the rollback latch. A new release is served on arrival unless the
-- site is held; a rollback sets it, and it stays set until the owner lets go.
--
-- A deleted site keeps its row so the name answers 410 rather than becoming
-- somebody else's; `deleted_at` is that memory.
CREATE TABLE "kthx_sites" (
	"name" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"serving" integer,
	"held" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kthx_releases" (
	"site" text NOT NULL,
	"n" integer NOT NULL,
	"digest" text NOT NULL,
	"location" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kthx_releases_site_n_pk" PRIMARY KEY("site","n"),
	CONSTRAINT "kthx_releases_site_kthx_sites_name_fk" FOREIGN KEY ("site") REFERENCES "public"."kthx_sites"("name") ON DELETE cascade ON UPDATE no action
);
