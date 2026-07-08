CREATE TABLE vaults (
    user_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    meta text,
    data text,
    settings text,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    PRIMARY KEY (user_id, namespace_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id) ON DELETE CASCADE
);
