### Example of `dploy.config.json`

```json
{
  "buildDir": "build",
  "strategy": "hybrid",
  "include": [
    "dist/**",
    "public/**"
  ],
  "exclude": [
    "**/*.test.js",
    "node_modules/**"
  ],
  "copy": [
    {
      "from": "package.json",
      "to": "package.json"
    },
    {
      "from": ".env.example",
      "to": ".env",
      "optional": true
    }
  ],
  "environments": {
    "production": {
      "deployTo": "/var/www/myapp",
      "keepVersions": 5,
      "healthCheckPath": "/health"
    }
  }
}
```

#### Strategy precedence:

- Allowed strategy types: `["include", "exclude", "copy", "hybrid"]`

------------

- `hybrid` → apply include/exclude globs and explicit copy entries
- `include` → only include these patterns (exclude refines it)
- `exclude` → include everything except excluded
- `copy` → just copy mappings (Step 1 behavior)
- _**If no strategy is specified → default to `copy` (backward compatible).**_

#### Example Configs

- Include strategy

```json
{
  "strategy": "include",
  "include": [
    "dist/**",
    "public/**"
  ],
  "exclude": [
    "**/*.test.js"
  ]
}
```

- Exclude strategy

```json
{
  "strategy": "exclude",
  "exclude": [
    "node_modules/**",
    "tests/**",
    "*.log"
  ]
}
```

- Hybrid strategy

```json
{
  "strategy": "hybrid",
  "include": [
    "dist/**"
  ],
  "exclude": [
    "dist/tests/**"
  ],
  "copy": [
    {
      "from": "package.json",
      "to": "package.json"
    },
    {
      "from": ".env.example",
      "to": ".env",
      "optional": true
    }
  ]
}
```
