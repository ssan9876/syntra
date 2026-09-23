ALTER TABLE "PersonDuplicateReview" DROP CONSTRAINT "PersonDuplicateReview_resolution_valid";
ALTER TABLE "PersonDuplicateReview" ADD CONSTRAINT "PersonDuplicateReview_resolution_valid"
  CHECK ("resolution" IS NULL OR "resolution" IN ('keep_separate', 'link_existing', 'skip_source_record'));
