# Tropy HTTP API Reference

Tropy exposes a local HTTP API for programmatic access to project data. The API runs on `127.0.0.1` (default port `2019`).

> **Source:** `src/common/api.js` in the Tropy codebase. Routes use Koa + `@koa/router`. Body parsing supports both JSON and `application/x-www-form-urlencoded`.

---

## Root 

### `GET /`

Returns project status.

**Response:**
```json
{
  "project": "/path/to/project.tpy",
  "status": "ok",
  "version": "1.17.3"
}
```

### `GET /version`

Returns the Tropy version.

**Response:**
```json
{
  "version": "1.17.3"
}
```

---

## Items

### `GET /project/items`

List all items in the project.

**Query Parameters:**

| Parameter | Type     | Description                          |
|-----------|----------|--------------------------------------|
| `q`       | string   | Full-text search query               |
| `tag`     | int/int[]| Filter by tag ID(s)                  |
| `sort`    | string   | Sort column (default: `item.created`)|
| `reverse` | boolean  | Reverse sort order (default: `false`)|

**Response:**
```json
[
  {
    "id": 1,
    "lists": [],
    "photos": [2],
    "tags": [],
    "template": "https://tropy.org/v1/templates/generic",
    "created": "2026-02-08T20:10:00.184Z",
    "modified": "2026-02-08T20:10:00.000Z",
    "deleted": false
  }
]
```

> **Note:** Returns flat summaries. `photos`, `tags` are arrays of **IDs**, not nested objects. Use the individual endpoints below to get full data.

### `GET /project/items/:id`

Show a specific item.

**Response:** Same format as a single item in the list above, or `404`.

### `GET /project/items/:id/photos`

List photos for an item.

**Response:**
```json
[
  {
    "id": 2,
    "selections": [],
    "notes": [1],
    "transcriptions": [],
    "item": 1,
    "template": "https://tropy.org/v1/templates/photo",
    "angle": 0,
    "color": "rgb(255,255,255,1)",
    "density": null,
    "brightness": 0,
    "contrast": 0,
    "hue": 0,
    "saturation": 0,
    "sharpen": 0,
    "width": 512,
    "height": 512,
    "filename": "image.png",
    "page": 0,
    "size": 16676,
    "protocol": "file",
    "mimetype": "image/png",
    "checksum": "93f0b6157adda7269cc784e5b0e2f088",
    "orientation": 1,
    "created": "2026-02-08T20:10:00.187Z",
    "modified": "2026-02-08T20:10:00.000Z",
    "mirror": false,
    "negative": false,
    "path": "/path/to/photo.png"
  }
]
```

> `notes`, `selections`, `transcriptions` are arrays of **IDs**.

### `GET /project/items/:id/tags`

List tags for an item.

**Query Parameters:**

| Parameter | Type    | Description          |
|-----------|---------|----------------------|
| `reverse` | boolean | Reverse sort order   |

**Response:** Array of tag objects (same as `GET /project/tags/:id`).

### `POST /project/items/:id/tags`

Add existing tags to an item by tag ID.

**Body (JSON or form-encoded):**

| Parameter | Type     | Required | Description           |
|-----------|----------|----------|-----------------------|
| `tag`     | int/int[]| Yes      | Tag ID(s) to add      |

**Response:** Updated tags object.

### `DELETE /project/items/:id/tags`

Remove tags from an item. If `tag` is omitted, clears all tags.

**Body (JSON or form-encoded):**

| Parameter | Type     | Required | Description           |
|-----------|----------|----------|-----------------------|
| `tag`     | int/int[]| No       | Tag ID(s) to remove   |

**Response:** Updated tags object.

### `GET /project/items/:id/transcriptions`

Get transcriptions for an item (concatenated across all photos/selections).

**Query Parameters:**

| Parameter   | Type   | Description                                     |
|-------------|--------|-------------------------------------------------|
| `format`    | string | Output format: `json`, `html`, `plain`, `text`  |
| `separator` | string | Separator between transcriptions (regex: `^[*_=-]+$`) |

**Response:** Transcription content in the requested format, or `404`.

---

## Metadata

### `GET /project/data/:id`

Get metadata for any subject (item, photo, or selection) by its ID.

**Response:**
```json
{
  "id": 1,
  "http://purl.org/dc/elements/1.1/title": {
    "type": "http://www.w3.org/2001/XMLSchema#string",
    "text": "District profile extras 071"
  }
}
```

Property keys are URIs (Dublin Core, custom templates, etc.). Each value has `text` and `type` fields.

### `POST /project/data/:id`

Save metadata for a subject. **Requires `Content-Type: application/json`.**

**Body (JSON):**

A flat object with property URIs as keys. Values can be:
- **String:** Auto-wrapped as `{ text: "...", type: "text" }`
- **Object:** `{ text: "value", type: "http://www.w3.org/2001/XMLSchema#string" }`

```json
{
  "http://purl.org/dc/elements/1.1/title": {
    "text": "My Title",
    "type": "http://www.w3.org/2001/XMLSchema#string"
  },
  "http://purl.org/dc/elements/1.1/date": "2026-01-01"
}
```

**Response:** Saved metadata object.

---

## Notes

### `GET /project/notes/:id`

Get a note by ID.

**Query Parameters:**

| Parameter | Type   | Description                                              |
|-----------|--------|----------------------------------------------------------|
| `format`  | string | Output format: `json`, `html`, `plain`, `text`, `md`, `markdown` |

**Response varies by format:**

- **No format / `json`:** JSON object
  ```json
  {
    "id": 1,
    "photo": 2,
    "selection": null,
    "text": "plain text content",
    "language": "en",
    "created": "2026-02-08T20:37:46.000Z",
    "modified": "2026-02-08T21:03:20.827Z"
  }
  ```
- **`html`:** Raw HTML string (`Content-Type: text/html`)
  ```html
  <p>paragraph one</p><p>paragraph two</p>
  ```
- **`plain` / `text`:** Plain text (`Content-Type: text/plain`)
- **`md` / `markdown`:** Markdown (`Content-Type: text/markdown`)

### `POST /project/notes`

Create a new note.

**Body (JSON or form-encoded):**

| Parameter   | Type   | Required | Description                            |
|-------------|--------|----------|----------------------------------------|
| `html`      | string | Yes      | HTML content of the note               |
| `photo`     | int    | *        | Photo ID to attach the note to         |
| `selection` | int    | *        | Selection ID to attach the note to     |
| `language`  | string | No       | Language code (e.g., `en`, `fr`)       |

> *Either `photo` or `selection` must be provided.

**Response:**
```json
{
  "id": [42]
}
```

### `DELETE /project/notes/:id`

Delete a note by ID.

**Response:** `200` if deleted, `404` if not found.

---

## Tags

### `GET /project/tags`

List all tags in the project.

**Query Parameters:**

| Parameter | Type    | Description          |
|-----------|---------|----------------------|
| `reverse` | boolean | Reverse sort order   |

**Response:** Array of tag objects.

### `GET /project/tags/:id`

Show a specific tag.

**Response:** Tag object or `404`.

### `POST /project/tags`

Create a new tag.

**Body (JSON or form-encoded):**

| Parameter | Type     | Required | Description                       |
|-----------|----------|----------|-----------------------------------|
| `name`    | string   | Yes      | Tag name                          |
| `color`   | string   | No       | Color value                       |
| `item`    | int/int[]| No       | Item ID(s) to apply the tag to    |

**Response:** Created tag object.

### `DELETE /project/tags`

Delete tags.

**Body (JSON or form-encoded):**

| Parameter | Type     | Required | Description           |
|-----------|----------|----------|-----------------------|
| `tag`     | int/int[]| Yes      | Tag ID(s) to delete   |

**Response:** Deleted tags info.

---

## Photos

### `GET /project/photos/:id`

Show photo metadata.

**Response:**
```json
{
  "id": 2,
  "selections": [],
  "notes": [1],
  "transcriptions": [],
  "item": 1,
  "template": "https://tropy.org/v1/templates/photo",
  "checksum": "93f0b6157adda7269cc784e5b0e2f088",
  "filename": "image.png",
  "width": 512,
  "height": 512,
  "mimetype": "image/png",
  "protocol": "file",
  "path": "/path/to/photo.png",
  "...": "..."
}
```

### `GET /project/photos/:id/raw`

Get the original photo file. Returns the file with appropriate `Content-Type`, or redirects to the source URL for HTTP/HTTPS photos.

### `GET /project/photos/:id/file.:format`

Get the photo converted to a specific format.

**Path Parameters:**

| Parameter | Values                    |
|-----------|---------------------------|
| `format`  | `jpg`, `png`, `webp`, `raw` |

---

## Selections

### `GET /project/selections/:id`

Show selection metadata. Response format similar to photos.

### `GET /project/selections/:id/file.:format`

Get the selection as an image in the specified format.

**Path Parameters:**

| Parameter | Values                    |
|-----------|---------------------------|
| `format`  | `jpg`, `png`, `webp`, `raw` |

---

## Transcriptions

### `GET /project/transcriptions/:id`

Get a transcription by ID.

**Query Parameters:**

| Parameter | Type   | Description                                                    |
|-----------|--------|----------------------------------------------------------------|
| `format`  | string | Output format: `json`, `html`, `plain`, `text` |

### `POST /project/transcriptions`

Create a new transcription.

**Body (JSON or form-encoded):**

| Parameter   | Type   | Required | Description                            |
|-------------|--------|----------|----------------------------------------|
| `data`      | object | *        | Structured transcription data          |
| `text`      | string | *        | Plain text transcription               |
| `angle`     | number | No       | Image rotation angle                   |
| `mirror`    | boolean| No       | Mirror transformation                  |
| `photo`     | int    | **       | Photo ID                               |
| `selection` | int    | **       | Selection ID                           |

> *Either `data` or `text` must be provided.
> **Either `photo` or `selection` must be provided.

**Response:**
```json
{
  "id": [1]
}
```

---

## Lists

### `GET /project/lists{/:id}`

Show a list. If `id` is omitted, returns the root list (id `0`).

**Query Parameters:**

| Parameter | Type    | Description           |
|-----------|---------|-----------------------|
| `expand`  | boolean | Expand list items     |

**Response:** List object or `404`.

### `GET /project/lists/:id/items`

List items in a specific list. Same query parameters as `GET /project/items`.

---

## Import

### `POST /project/import`

Import items into the project. **Requires `Content-Type: application/x-www-form-urlencoded`.**

**Body (form-encoded):**

| Parameter | Type   | Required | Description                                 |
|-----------|--------|----------|---------------------------------------------|
| `file`    | string | *        | File path or URL to import                  |
| `data`    | string | *        | JSON-LD items as a JSON string              |
| `list`    | int    | No       | Target list ID to import into               |

> *Either `file` or `data` must be provided.

---

## Important Notes

1. **Flat REST format:** Item and photo lists return **ID references** (e.g., `photos: [2]`), not nested objects. Fetch individual resources to get full data.
2. **Metadata saves require JSON:** `POST /project/data/:id` rejects non-JSON content types with `400`.
3. **Note creation requires HTML:** The `html` parameter is mandatory for `POST /project/notes`.
4. **ID coercion:** Photo and selection IDs in request bodies are coerced to numbers.
5. **Error responses:** Standard HTTP status codes. `404` for not found, `400` for bad requests.
