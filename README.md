# Gradescope Course Archiver & Git Tool

A powerful Python script to download all your Gradescope course materials and automatically create individual Git repositories for each course. Keep permanent, organized access to your college work.

## Features

- **Automated Downloads:** Fetches all assignments, submissions, and feedback from your Gradescope courses.
- **Session Persistence:** Handles SSO and 2FA with a one-time manual login, saving your session for future runs.
- **Organized by Course:** Creates a separate, clean directory for each course.
- **Automatic Git Integration:** Initializes a Git repository for each course and provides instructions for pushing to a remote like GitHub.
- **Flexible & Interactive:** Offers both a fully automated "download-all" mode and an interactive mode to select courses one-by-one.
- **Course Management:** Includes tools to update your course list, rename local directories, and manage associated GitHub repositories.

## Requirements

- Python 3.8+
- The dependencies listed in `requirements.txt`.
- **(Optional)** The [GitHub CLI](https://cli.github.com/) (`gh`) is required for some repository management features like `--nuke-all`.

## Installation & Setup

1.  **Clone the repository and install dependencies:**
    ```bash
    git clone <repository_url>
    cd <repository_directory>
    pip install -r requirements.txt
    playwright install
    ```

2.  **Authenticate with Gradescope:**
    Run the `--setup` command. This will open a browser window.
    ```bash
    python gradescope_archiver.py --setup
    ```
    Log in to Gradescope as you normally would, completing any 2FA steps. Once you are logged in, the script will save your session to a `gradescope_auth.json` file. This file is included in `.gitignore` and should not be committed.

## Commands

The script is controlled via command-line arguments.

| Command                   | Description                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--setup`                 | **(First time only)** Opens a browser for you to log in and saves your session.                                                            |
| `--interactive`           | Runs an interactive a guided experience to select courses to download one-by-one.                                                    |
| `--download-all`          | Downloads all your courses and assignments in a non-interactive mode.                                                                    |
| `--test-course "COURSE"`  | Downloads a single, specified course. Use the full course name in quotes (e.g., "CS 101: Intro to Programming").                          |
| `--update-courses`        | Refreshes your local `courses.json` file with the latest list of courses from Gradescope.                                                |
| `--update-stale-courses`  | Re-downloads any courses that haven't been updated recently (based on a configurable threshold).                                          |
| `--rename-courses`        | Renames local course directories based on the `rename` field you can manually edit in the `courses.json` file.                           |
| `--nuke-all`              | **[DANGEROUS]** Deletes all GitHub repositories listed in `courses.json`. Requires `gh` CLI.                                             |

## Recommended Workflow

1.  **Setup:** Run `python gradescope_archiver.py --setup` to authenticate.
2.  **Update Course List:** Run `python gradescope_archiver.py --update-courses` to create a `courses.json` file.
3.  **(Optional) Rename Courses:** If you want custom directory names, edit the `rename` field for each course in `courses.json`. Then run `python gradescope_archiver.py --rename-courses`.
4.  **Download:**
    -   For a fully automated experience, use `python gradescope_archiver.py --download-all`.
    -   To pick and choose, use `python gradescope_archiver.py --interactive`.
5.  **Push to GitHub:** After downloading, the script will provide instructions on how to create a remote repository on GitHub and push your local course repositories.

## Key Files

-   `gradescope_archiver.py`: The main script you will run.
-   `gradescope_lib.py`: A library of core functions for interacting with Gradescope and Git.
-   `gradescope_course_manager.py`: Manages the `courses.json` file.
-   `courses.json`: A local database of your courses, their metadata, and associated GitHub repository links.
-   `gradescope_auth.json`: Your saved authentication session. **(Do not share this file)**.

---

### <p align="center">⚠️ DANGER ZONE ⚠️</p>

The `--nuke-all` command is a destructive operation that will permanently delete your remote GitHub repositories. It is intended for development and testing purposes.

**Use with extreme caution.** There is no undo.