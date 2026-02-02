# Gradescope Course Archiver - Project Spec

## Overview
Build a Python script that downloads all your Gradescope course materials and creates individual Git repositories for each course, so you have permanent access to your college work.

## Goals
- **One-time run**: Download everything once, create repos, done
- **Handle UCLA SSO + 2FA**: Use session persistence to avoid repeated 2FA
- **Organize by course**: Each course gets its own directory and git repo
- **Automation**: Minimal manual intervention after initial login

---

## Architecture

### Tech Stack
- **Playwright** (Python) - Modern web automation, better than Selenium
- **GitPython** or `subprocess` - Git operations
- **Python 3.8+** - Standard libraries + playwright

### File Structure
```
project/
├── gradescope_archiver.py       # Main script
├── gradescope_auth.json          # Saved session (gitignored)
├── .gitignore
├── requirements.txt
└── gradescope_archive/           # Output directory
    ├── CS-180-Algorithms/
    │   ├── .git/
    │   ├── README.md
    │   ├── Assignment-1/
    │   ├── Assignment-2/
    │   └── course_info.json
    ├── CS-111-Operating-Systems/
    │   └── ...
    └── ...
```

---

## Key Features

### 1. Authentication with Session Persistence
**Problem**: UCLA uses SSO with 2FA  
**Solution**: Manual login once, save session, reuse it

**Implementation**:
```python
# First run - setup
def setup_auth():
    - Launch browser (headless=False)
    - Navigate to gradescope.com
    - Wait for user to manually login + 2FA
    - Save session to gradescope_auth.json using context.storage_state()
    
# Subsequent runs
def run_scraper():
    - Load session from gradescope_auth.json
    - Browser starts already authenticated
    - No 2FA needed
```

**Session file**: Store as JSON, add to .gitignore

---

## Do You Need IP Rotation / Anti-Detection?

**TL;DR: NO, you don't need it for this use case.**

### Why You DON'T Need IP Rotation:

1. **You're using your real account** - You're logging in with your actual UCLA credentials
2. **Legitimate use** - You're downloading YOUR OWN coursework that you have access to
3. **Low volume** - This is a one-time run, not continuous scraping
4. **Session-based auth** - You already have a valid session from manual login
5. **Reasonable rate limits** - 1-2 second delays are plenty

### What Gradescope Cares About:
- ❌ Bots creating fake accounts
- ❌ Scraping other students' work
- ❌ DDoS-level request volumes
- ✅ Students downloading their own submissions - **This is fine**

### Simple Anti-Detection Measures (already sufficient):

```python
# This is all you need:
CONFIG = {
    'delay': 2,  # 2 seconds between requests
    'headless': False,  # Use real browser (can set True later)
    'user_agent': None,  # Playwright uses real Chrome UA by default
}

# In your script:
time.sleep(CONFIG['delay'])  # Between each download
```

### When You WOULD Need IP Rotation:
- Scraping public data at high volume (1000s of requests)
- Bypassing IP-based rate limits
- Hiding your identity
- **None of these apply to your use case**

### Red Flags That WOULD Get You Blocked:
- Hundreds of requests per second
- Downloading courses you're not enrolled in
- Running the script 24/7
- Multiple concurrent sessions from same account

### Your Actual Risk Level: **Very Low**
You're just a student downloading your own coursework once. Gradescope is not going to care. The 2FA login itself proves you're legitimate.

**Bottom line**: Don't overthink it. Add reasonable delays (1-2 seconds), don't hammer their servers, and you'll be fine.

---

### 2. Course Discovery
**Goal**: Get list of all enrolled courses (including archived ones)

**Steps**:
1. Navigate to `https://www.gradescope.com/courses`
2. Wait for page load (`networkidle`)
3. **IMPORTANT**: Click "See Older Courses" button if it exists
   - Selector: `button:has-text("See older courses")` or similar
   - This reveals archived/past courses
   - May need to click multiple times or scroll
   - Wait for new courses to load after each click
4. Find all course elements - try multiple selectors:
   - `.courseBox`
   - `a[href*="/courses/"]`
   - `.course-link`
5. Extract for each course:
   - Course name
   - Course URL
   - (Optional) Term/year if visible

**Implementation**:
```python
def get_all_courses(page):
    page.goto('https://www.gradescope.com/courses')
    page.wait_for_load_state('networkidle')
    
    # Keep clicking "See older courses" until it's gone
    while True:
        try:
            older_button = page.wait_for_selector(
                'button:has-text("older"), button:has-text("Older")', 
                timeout=2000
            )
            older_button.click()
            time.sleep(1)  # Wait for courses to load
            page.wait_for_load_state('networkidle')
        except:
            break  # No more older courses
    
    # Now get all courses
    courses = []
    # ... extraction logic
```

**Data structure**:
```python
courses = [
    {
        'name': 'CS 180 - Algorithms',
        'url': 'https://gradescope.com/courses/12345',
        'term': 'Fall 2024'  # optional
    },
    ...
]
```

---

### 3. Assignment Downloading
**For each course**:

1. Navigate to course page
2. Find all assignments:
   - Look for assignment links
   - Common selectors: `a[href*="/assignments/"]`, `.assignment-link`
3. For each assignment:
   - Click into assignment
   - Look for submission downloads:
     - "Download Submission" button
     - "View Submission" → download files
     - PDF of graded work
   - **Download ALL file types**:
     - **PDFs** - Graded submissions, feedback
     - **Code files** - `.py`, `.java`, `.cpp`, `.js`, etc.
     - **Notebooks** - `.ipynb` files
     - **Screenshots/Images** - `.png`, `.jpg`, `.jpeg`
     - **Documents** - `.docx`, `.txt`, `.md`
     - **Archives** - `.zip`, `.tar.gz`
     - **Any other files** - Just download everything
   - Save to: `course_dir/assignment_name/`
4. **Handle different submission types**:
   - **Code upload**: Download source files directly
   - **PDF submission**: Download PDF
   - **Image submission**: Download images
   - **Multiple files**: Download all, preserve original names
   - **Gradescope viewer**: May need to trigger download button or save rendered content
5. Handle edge cases:
   - No submission (skip or note in JSON)
   - Multiple submissions (download all, maybe numbered)
   - Different file types (download everything)

**File download strategy**:
```python
def download_assignment_files(page, assignment_dir):
    # Set download directory
    context = page.context
    # Playwright will save downloads to this dir
    
    # Look for all download buttons/links
    download_triggers = [
        'button:has-text("Download")',
        'a:has-text("Download")',
        'a[download]',
        '.download-link'
    ]
    
    for selector in download_triggers:
        try:
            elements = page.query_selector_all(selector)
            for elem in elements:
                # Click and wait for download
                with page.expect_download() as download_info:
                    elem.click()
                download = download_info.value
                download.save_as(assignment_dir / download.suggested_filename)
        except:
            continue
    
    # Also check for inline files (like embedded images)
    # May need to screenshot if content isn't downloadable
```

**Rate limiting**: Add 1-2 second delays between requests

---

### 4. File Organization

**Directory structure per course**:
```
CS-180-Algorithms/
├── README.md                    # Auto-generated
├── course_info.json             # Metadata
├── Assignment-1-Sorting/
│   ├── submission.pdf           # Graded PDF
│   ├── solution.py              # Your code
│   ├── test_cases.py
│   └── feedback.pdf
├── Assignment-2-DP/
│   ├── notebook.ipynb           # Jupyter notebook
│   ├── analysis.pdf
│   └── screenshot.png
├── Midterm/
│   ├── exam.pdf
│   └── work_shown.jpg
└── Final-Project/
    ├── report.pdf
    ├── code.zip
    ├── presentation.pptx
    └── demo_screenshot.png
```

**course_info.json**:
```json
{
  "course_name": "CS 180 - Algorithms",
  "term": "Fall 2024",
  "gradescope_url": "https://...",
  "downloaded_at": "2025-01-30T10:30:00",
  "total_assignments": 12
}
```

**README.md** (auto-generated):
```markdown
# CS 180 - Algorithms

Course materials archived from Gradescope

**Term**: Fall 2024  
**Downloaded**: January 30, 2025

## Assignments
- Assignment 1: Sorting
- Assignment 2: Dynamic Programming
...
```

---

### 5. Git Repository Creation

**For each course directory**:

```python
def create_git_repo(course_path, course_name):
    os.chdir(course_path)
    
    # Initialize
    subprocess.run(['git', 'init'])
    subprocess.run(['git', 'add', '.'])
    subprocess.run(['git', 'commit', '-m', 'Initial commit: Gradescope archive'])
    
    # Print push instructions
    print(f"To push to GitHub:")
    print(f"  cd {course_path}")
    print(f"  gh repo create {sanitized_name} --private")
    print(f"  git remote add origin <url>")
    print(f"  git push -u origin main")
```

**Note**: Don't auto-push to GitHub - just create local repos and print instructions. User can push manually or batch push later.

---

## Implementation Phases

### Phase 1: Auth + Course Discovery
- [ ] Setup Playwright
- [ ] Implement session save/load
- [ ] Navigate to courses page
- [ ] **Click "See Older Courses" until all courses visible**
- [ ] Extract all course names + URLs
- [ ] Print course list

### Phase 2: Download Single Course (Test) - **START WITH PDFs ONLY**
- [ ] Navigate to one course
- [ ] Find all assignments
- [ ] **Download ONLY PDF files first** (simplest case)
- [ ] Save to proper directory structure
- [ ] Test with YOUR most recent course
- [ ] Verify PDFs open correctly

### Phase 2.5: Add Other File Types
- [ ] Add support for code files (.py, .java, .cpp, .js)
- [ ] Add support for Jupyter notebooks (.ipynb)
- [ ] Add support for images/screenshots (.png, .jpg)
- [ ] Add support for any other file types (.zip, .docx, etc.)
- [ ] Test with course that has mixed file types

### Phase 3: Full Automation
- [ ] Loop through all courses
- [ ] Download all assignments (all file types)
- [ ] Add progress indicators
- [ ] Error handling (missing files, network issues)

### Phase 4: Git Integration
- [ ] Create git repos for each course
- [ ] Generate README files
- [ ] Save metadata JSONs
- [ ] Print push instructions

---

## Edge Cases & Error Handling

### Handle These Cases:
1. **No submissions**: Assignment exists but you never submitted
   - Solution: Create empty folder with note.txt
2. **Session expired**: Auth file is old
   - Solution: Catch login redirect, prompt to re-auth
3. **Rate limiting**: Gradescope blocks rapid requests
   - Solution: Add delays, exponential backoff (but unlikely to be needed)
4. **Assignment types vary**: Some are PDFs, some are code uploads, some are notebooks
   - Solution: Download whatever's available, preserve original filenames
5. **Network errors**: Timeout, connection issues
   - Solution: Retry logic (max 3 attempts)
6. **Page structure changed**: Selectors don't work
   - Solution: Try multiple selectors, graceful failure
7. **Jupyter notebooks (.ipynb)**: May be rendered in browser vs downloadable
   - Solution: Look for download button first, fallback to saving page content as .ipynb
8. **Screenshots/images**: Submitted as images vs embedded in PDF
   - Solution: Download image files directly, check for `<img>` tags with submission screenshots
9. **Multi-file submissions**: Student uploaded multiple files as one submission
   - Solution: Download all files, keep original names or add numbering if conflicts

### Error Logging:
```python
errors = []
# During scraping
errors.append({
    'course': 'CS 180',
    'assignment': 'HW 3',
    'error': 'Download button not found'
})

# At end, save to errors.json
```

---

## Usage Flow

### First Time:
```bash
# Install
pip install playwright
playwright install chromium

# Setup auth
python gradescope_archiver.py --setup

# Downloads everything
python gradescope_archiver.py --download

# Creates git repos
python gradescope_archiver.py --create-repos
```

### Or single command:
```bash
python gradescope_archiver.py --setup --download --create-repos
```

---

## Configuration

**Config at top of script**:
```python
# Configuration
OUTPUT_DIR = "gradescope_archive"
AUTH_FILE = "gradescope_auth.json"
DOWNLOAD_DELAY = 2  # seconds between downloads
HEADLESS = False  # Set True once tested
MAX_RETRIES = 3
```

---

## Selectors Cheatsheet
*These might change - inspect Gradescope to verify*

```python
# Common Gradescope selectors (as of 2024)
SELECTORS = {
    'courses': [
        '.courseBox',
        'a[href*="/courses/"]',
        '.course-card'
    ],
    'course_name': [
        '.courseBox--name',
        '.courseName',
        'h3.course-title'
    ],
    'assignments': [
        'a[href*="/assignments/"]',
        '.table--primaryLink',
        '.assignment-link'
    ],
    'download_buttons': [
        'button:has-text("Download")',
        'a:has-text("Download Submission")',
        '.downloadButton'
    ]
}
```

**Tip**: Use Playwright inspector to find selectors:
```bash
playwright codegen gradescope.com
```

---

## Testing Strategy

1. **Manual test first**: 
   - Log in manually
   - Click through one course
   - Note exact button clicks needed
   
2. **Test on one course**:
   - Hardcode one course URL
   - Make sure download works end-to-end
   
3. **Then automate all**:
   - Once single course works, loop through all

---

## After Script Runs

### Pushing to GitHub:
```bash
# Option 1: Manual per repo
cd gradescope_archive/CS-180-Algorithms
gh repo create CS-180-Algorithms --private
git remote add origin <url>
git push -u origin main

# Option 2: Batch script (create this after)
for dir in gradescope_archive/*/; do
    cd "$dir"
    repo_name=$(basename "$dir")
    gh repo create "$repo_name" --private
    git remote add origin "https://github.com/yourusername/$repo_name.git"
    git push -u origin main
    cd ../..
done
```

### Storage:
- GitHub free tier: unlimited private repos
- Each course probably < 100MB
- Total likely < 1-2GB for all college work

---

## Alternative Approaches (if main approach fails)

### If Gradescope blocks scraping:
1. **Browser extension**: Build Chrome extension to download as you browse
2. **Manual archive**: Click through yourself, script just organizes + creates repos
3. **PDF print**: Print each assignment to PDF manually

### If download buttons don't exist:
- Screenshot submissions instead
- Save HTML of graded work
- At least preserve the feedback/grades

---

## Security Notes

- **Don't commit auth file**: Add to .gitignore
- **Use environment variables** for credentials if you hardcode anything
- **Private repos**: Always make GitHub repos private (contains your schoolwork)
- **Respect Gradescope ToS**: This is for personal archival, not sharing

---

## Script Template Structure

```python
#!/usr/bin/env python3
import os
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess

CONFIG = {
    'output_dir': 'gradescope_archive',
    'auth_file': 'gradescope_auth.json',
    'delay': 2,
    'headless': False
}

def setup_auth():
    """Manual login + save session"""
    pass

def get_courses(page):
    """Return list of course dicts"""
    pass

def download_course(page, course, output_dir):
    """Download all assignments for one course"""
    pass

def create_git_repo(course_dir):
    """Initialize git repo"""
    pass

def main():
    # 1. Check if auth exists, if not run setup
    # 2. Load session
    # 3. Get all courses
    # 4. For each course: download + create repo
    # 5. Print summary
    pass

if __name__ == '__main__':
    main()
```

---

## Success Criteria

✅ Script completes without manual intervention (after initial 2FA)  
✅ All courses downloaded to separate folders  
✅ Git repos created for each course  
✅ Clear instructions printed for GitHub push  
✅ Error log shows any failures  
✅ Can re-run safely (doesn't re-download existing files)  

---

## Time Estimate
- Phase 1: 30-45 min
- Phase 2: 1-2 hours (testing/debugging selectors)
- Phase 3: 30 min
- Phase 4: 30 min
- **Total**: 3-4 hours including testing

---

## Resources

- [Playwright Python Docs](https://playwright.dev/python/docs/intro)
- [Playwright Selectors](https://playwright.dev/python/docs/selectors)
- [GitPython Docs](https://gitpython.readthedocs.io/)
- Gradescope: Inspect element to find current selectors

---

## Notes
- This is a one-time script, doesn't need to be perfect
- Prioritize getting it working over making it elegant
- If something fails, just note it and move on
- Can always manually download problematic courses

Good luck! 🚀