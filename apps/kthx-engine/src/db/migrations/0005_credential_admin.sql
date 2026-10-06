ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'credential_admin';--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'add_passkey';--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_gateway_identity_unique" UNIQUE("gateway_identity");
