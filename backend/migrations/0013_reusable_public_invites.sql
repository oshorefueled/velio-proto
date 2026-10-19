-- Refuse conflicting history rather than deleting or rewriting saved invitations.
CREATE UNIQUE INDEX invites_public_account_activity
  ON invites (creator_id, activity_id) WHERE rail = 'public_share';
