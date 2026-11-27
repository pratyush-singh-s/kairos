-- Schema version 7: how a deadline's day progress is drawn (0.14.0).
--   progress_style: 'grid' (rows of cells) or 'bars' (one tall bar per day).
--   cell_shape: 'rounded' (rounded square), 'circle' or 'square'.
--   grid_cols: cells per row; NULL = automatic (a week per row for the grid).
ALTER TABLE deadlines ADD COLUMN progress_style TEXT NOT NULL DEFAULT 'grid' CHECK (progress_style IN ('grid', 'bars'));
ALTER TABLE deadlines ADD COLUMN cell_shape TEXT NOT NULL DEFAULT 'rounded' CHECK (cell_shape IN ('rounded', 'circle', 'square'));
ALTER TABLE deadlines ADD COLUMN grid_cols INTEGER CHECK (grid_cols IS NULL OR grid_cols BETWEEN 1 AND 60);
