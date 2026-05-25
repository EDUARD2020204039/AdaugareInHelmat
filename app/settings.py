from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_DIR = BASE_DIR / "data"


class Settings(BaseSettings):
    app_host: str = "0.0.0.0"
    app_port: int = 5005

    odoo_url: str = "https://hello.helpan.ro"
    odoo_db: str = "helmat1"
    odoo_user: str = "managehaba@gmail.com"
    odoo_password: str = ""
    odoo_stock_location_name: str = "WH/Stock"

    swan_api_url: str = ""
    swan_bearer_token: str = ""
    swan_push_api_url: str = ""
    swan_push_bearer_token: str = ""

    admin_token: str = ""
    promo_view_id: int | None = None

    @field_validator("promo_view_id", mode="before")
    @classmethod
    def empty_int_is_none(cls, value: object) -> object:
        if value == "":
            return None
        return value

    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
UPLOAD_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)
