"""The only module (besides other repos) that issues User queries."""

from sqlalchemy import select

from app.db.models import User


def create_guest(db) -> User:
    user = User(is_guest=True, display_name="Guest", ui_language=None)
    db.add(user)
    db.flush()  # assign the default-generated id
    return user


def get(db, user_id: str) -> User | None:
    return db.get(User, user_id)


def get_by_github_id(db, github_id: int) -> User | None:
    return db.execute(select(User).where(User.github_id == github_id)).scalar_one_or_none()


def set_ui_language(db, user: User, lang: str | None) -> User:
    user.ui_language = lang
    db.add(user)
    db.flush()
    return user
