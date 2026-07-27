CREATE TYPE "public"."app_source_kind" AS ENUM('repo', 'archive');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('image', 'files');--> statement-breakpoint
CREATE TYPE "public"."attempt_event_type" AS ENUM('log', 'status');--> statement-breakpoint
CREATE TYPE "public"."attempt_kind" AS ENUM('build', 'deploy');--> statement-breakpoint
CREATE TYPE "public"."blame" AS ENUM('developer', 'platform');--> statement-breakpoint
CREATE TYPE "public"."build_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."component_kind" AS ENUM('service', 'website', 'job');--> statement-breakpoint
CREATE TYPE "public"."config_item_kind" AS ENUM('secret_ref', 'plain');--> statement-breakpoint
CREATE TYPE "public"."datastore_engine" AS ENUM('postgres', 'redis');--> statement-breakpoint
CREATE TYPE "public"."datastore_provenance" AS ENUM('managed', 'external');--> statement-breakpoint
CREATE TYPE "public"."deploy_phase" AS ENUM('PENDING', 'APPLYING', 'WAITING', 'LIVE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."deploy_reason" AS ENUM('BUILD_FAILED', 'ARTIFACT_UNAVAILABLE', 'REJECTED', 'STARTUP_FAILED', 'UNHEALTHY', 'TIMEOUT', 'TARGET_UNREACHABLE', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."exposure_state" AS ENUM('internal', 'private', 'public');--> statement-breakpoint
CREATE TYPE "public"."log_fidelity" AS ENUM('LIVE_TEXT', 'LIVE_STATUS', 'ON_COMPLETION');--> statement-breakpoint
CREATE TYPE "public"."target_adapter" AS ENUM('kubernetes', 'cloudrun', 'static');--> statement-breakpoint
CREATE TYPE "public"."target_status" AS ENUM('connected', 'disconnected');--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"source_kind" "app_source_kind" NOT NULL,
	"source_repo_url" text,
	"source_repo_subpath" text,
	"source_archive_digest" text,
	"vessel_ref" text,
	"vanity_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"attempt_kind" "attempt_kind" NOT NULL,
	"build_id" bigint,
	"deploy_id" bigint,
	"event_type" "attempt_event_type" NOT NULL,
	"line" text,
	"phase" text,
	"resource" text,
	"reason" "deploy_reason",
	"blame" "blame",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_events_exactly_one_attempt" CHECK (("attempt_events"."build_id" is not null) <> ("attempt_events"."deploy_id" is not null)),
	CONSTRAINT "attempt_events_kind_matches_reference" CHECK (("attempt_events"."attempt_kind" = 'build' and "attempt_events"."build_id" is not null) or ("attempt_events"."attempt_kind" = 'deploy' and "attempt_events"."deploy_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"component_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"target_shape" text NOT NULL,
	"artifact_type" "artifact_type" NOT NULL,
	"artifact_digest" text,
	"artifact_refs" jsonb,
	"status" "build_status" DEFAULT 'PENDING' NOT NULL,
	"base_digest" text,
	"runner" text,
	"log_fidelity" "log_fidelity",
	"provenance" jsonb,
	"bundle_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builds_component_commit_shape_unique" UNIQUE("component_id","commit","target_shape")
);
--> statement-breakpoint
CREATE TABLE "component_target_desired" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"desired_build_id" bigint,
	"desired_deploy_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_target_desired_pair_unique" UNIQUE("component_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "component_kind" NOT NULL,
	"expose" boolean,
	"schedule" text,
	"exposure" "exposure_state" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "components_app_id_name_unique" UNIQUE("app_id","name")
);
--> statement-breakpoint
CREATE TABLE "config_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"environment" text DEFAULT 'default' NOT NULL,
	"key" text NOT NULL,
	"kind" "config_item_kind" DEFAULT 'secret_ref' NOT NULL,
	"store_ref" text,
	"plain_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_items_scope_key_unique" UNIQUE("component_id","target_id","environment","key"),
	CONSTRAINT "config_items_environment_pinned" CHECK ("config_items"."environment" = 'default')
);
--> statement-breakpoint
CREATE TABLE "datastores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"engine" "datastore_engine" NOT NULL,
	"provenance" "datastore_provenance" NOT NULL,
	"app_id" uuid,
	"target_id" uuid NOT NULL,
	"connection_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"component_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"build_id" bigint NOT NULL,
	"phase" "deploy_phase" DEFAULT 'PENDING' NOT NULL,
	"reason" "deploy_reason",
	"blame" "blame",
	"detail" text,
	"debug" jsonb,
	"url" text,
	"config_version" text,
	"exposure" "exposure_state",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"adapter" "target_adapter" NOT NULL,
	"status" "target_status" DEFAULT 'connected' NOT NULL,
	"rank" integer NOT NULL,
	"public_exposure" boolean,
	"min_build_level" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"gateway_identity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_deploy_id_deploys_id_fk" FOREIGN KEY ("deploy_id") REFERENCES "public"."deploys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_target_desired" ADD CONSTRAINT "component_target_desired_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_target_desired" ADD CONSTRAINT "component_target_desired_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_target_desired" ADD CONSTRAINT "component_target_desired_desired_build_id_builds_id_fk" FOREIGN KEY ("desired_build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_target_desired" ADD CONSTRAINT "component_target_desired_desired_deploy_id_deploys_id_fk" FOREIGN KEY ("desired_deploy_id") REFERENCES "public"."deploys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_items" ADD CONSTRAINT "config_items_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_items" ADD CONSTRAINT "config_items_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datastores" ADD CONSTRAINT "datastores_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datastores" ADD CONSTRAINT "datastores_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE restrict ON UPDATE no action;