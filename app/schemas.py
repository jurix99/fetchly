"""Pydantic request models shared by the route modules."""

from __future__ import annotations

from pydantic import BaseModel


class DownloadRequest(BaseModel):
    url: str
    quality: str = ""  # empty -> use saved default quality
    format: str = "MP4"
    subfolder: str = ""


class ExtractRequest(BaseModel):
    url: str
    limit: int | None = None


class SearchRequest(BaseModel):
    query: str
    limit: int = 15


class ChannelVideosRequest(BaseModel):
    url: str
    offset: int = 0
    limit: int = 30


class SettingsRequest(BaseModel):
    default_quality: str | None = None
    watch_interval_minutes: int | None = None
    organize: str | None = None
    max_concurrent: int | None = None
    subtitles: bool | None = None
    subtitle_langs: str | None = None
    embed_subtitles: bool | None = None
    embed_thumbnail: bool | None = None
    embed_metadata: bool | None = None
    embed_chapters: bool | None = None
    sponsorblock: bool | None = None
    sponsorblock_mode: str | None = None
    bandwidth_limit: float | None = None
    download_archive: bool | None = None
    min_free_gb: float | None = None
    nfo_export: bool | None = None


class NotificationsRequest(BaseModel):
    enabled: bool | None = None
    urls: list[str] | None = None
    on_video: bool | None = None
    on_error: bool | None = None
    on_summary: bool | None = None


class CookiesRequest(BaseModel):
    content: str = ""


class FollowChannel(BaseModel):
    url: str
    title: str = ""
    avatar: str = ""


class FollowSubsRequest(BaseModel):
    channels: list[FollowChannel] = []
    backfill: bool = False


class SubscriptionFiltersModel(BaseModel):
    """Content filters aligned with the frontend SubscriptionFilters type.
    Durations in SECONDS (the UI edits minutes, converts at the API boundary).
    Keyword semantics: include = OR, exclude = OR, exclude wins over include."""
    min_duration: int | None = None
    max_duration: int | None = None
    exclude_shorts: bool = False
    exclude_lives: bool = False
    include_keywords: list[str] = []
    exclude_keywords: list[str] = []
    keep_last_n: int | None = None


class WatchRequest(BaseModel):
    url: str
    quality: str | None = None
    backfill: bool = True
    subfolder: str = ""
    date_after: str = ""
    title: str = ""
    thumbnail: str = ""
    exclude_shorts: bool = False
    exclude_lives: bool = False
    filters: SubscriptionFiltersModel | None = None


class WatchUpdate(BaseModel):
    enabled: bool | None = None
    quality: str | None = None
    subfolder: str | None = None
    date_after: str | None = None
    exclude_shorts: bool | None = None
    exclude_lives: bool | None = None
    filters: SubscriptionFiltersModel | None = None


class PreviewFiltersRequest(BaseModel):
    url: str
    filters: SubscriptionFiltersModel = SubscriptionFiltersModel()


class PluginSettingsRequest(BaseModel):
    settings: dict = {}


class BackfillRequest(BaseModel):
    only_missing: bool = True


class SearchFeedbackRequest(BaseModel):
    """LOCAL north-star instrumentation. `query_hash` comes back from /api/search;
    `clicked` marks that the search led to opening a result."""
    query_hash: str = ""
    clicked: bool = False


# Default filter template (mirrors the source plugin's _DEFAULT_FILTERS).
DEFAULT_FILTERS = {
    "min_duration": None,
    "max_duration": None,
    "exclude_shorts": False,
    "exclude_lives": False,
    "include_keywords": [],
    "exclude_keywords": [],
    "keep_last_n": None,
}
