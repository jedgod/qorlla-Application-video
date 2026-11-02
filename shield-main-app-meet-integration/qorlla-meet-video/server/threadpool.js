// Must be imported first: libuv sizes its thread pool on first use. bcrypt hashing runs there.
process.env.UV_THREADPOOL_SIZE ||= process.env.MEET_THREADPOOL_SIZE || '8';
