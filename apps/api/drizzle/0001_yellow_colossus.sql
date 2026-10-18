CREATE TYPE "public"."monitor_state" AS ENUM('pending', 'up', 'degraded', 'down');--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "state" "monitor_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "next_check_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_state_change_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "consecutive_successes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("next_check_at") WHERE paused = false;