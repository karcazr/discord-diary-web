CREATE TABLE revision_guard (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CONSTRAINT diary_revision CHECK(revision>=0)
);
INSERT INTO revision_guard VALUES (1, 0);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  zone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  next_zone TEXT,
  next_at INTEGER,
  community INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX accounts_community ON accounts(community);

CREATE TABLE oauth_states (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE INDEX oauth_expiry ON oauth_states(expires);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL REFERENCES accounts(id),
  day TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  length INTEGER NOT NULL,
  roll INTEGER NOT NULL,
  gold INTEGER NOT NULL,
  shared INTEGER NOT NULL,
  eligible INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(user, day)
);
CREATE INDEX posts_public ON posts(id DESC) WHERE shared=1 AND eligible=1;

CREATE TABLE reactions (
  user TEXT NOT NULL REFERENCES accounts(id),
  post INTEGER NOT NULL REFERENCES posts(id),
  day TEXT NOT NULL,
  emoji TEXT NOT NULL,
  gold INTEGER NOT NULL,
  tickets INTEGER NOT NULL,
  PRIMARY KEY(user, post)
);
CREATE INDEX reactions_post ON reactions(post);

CREATE TABLE awards (
  user TEXT NOT NULL REFERENCES accounts(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  day TEXT NOT NULL,
  gold INTEGER NOT NULL,
  tickets INTEGER NOT NULL,
  shields INTEGER NOT NULL,
  PRIMARY KEY(user, key)
);
CREATE INDEX awards_recent ON awards(day DESC);

CREATE TABLE purchases (
  user TEXT NOT NULL REFERENCES accounts(id),
  request TEXT NOT NULL,
  day TEXT NOT NULL,
  item TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  restored INTEGER NOT NULL,
  PRIMARY KEY(user, request)
);
