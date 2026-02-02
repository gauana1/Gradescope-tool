#!/usr/bin/env python3
import os
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, Page
import subprocess
import re
import requests
import zipfile
import tarfile
import shutil

CONFIG = {
    'output_dir': 'gradescope_archive',
    'auth_file': 'gradescope_auth.json',
    'delay': 2,
    'headless': False,
    'max_retries': 3
}

def setup_auth():
    """Manual login + save session"""
    print("Setting up authentication...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto("https://www.gradescope.com/")
            print("Please log in to Gradescope in the browser window, including any 2FA.")
            print("Once you see your course dashboard, you can close the browser window.")
            page.wait_for_function("() => false", timeout=0)
        except Exception:
            print("\nBrowser closed. Assuming login was successful.")
        
        context.storage_state(path=CONFIG['auth_file'])
        print(f"Authentication session saved to {CONFIG['auth_file']}.")

def get_courses(page: Page) -> list:
    """Return list of course dicts"""
    print("Discovering courses...")
    page.goto('https://www.gradescope.com/')
    page.wait_for_load_state('networkidle')
    try:
        page.get_by_role("link", name="Gradescope: Back to Home").click()
        page.wait_for_load_state('networkidle')
    except Exception:
        page.goto('https://www.gradescope.com/courses')
        page.wait_for_load_state('networkidle')

    courses = []
    while True:
        try:
            older_button = page.get_by_role("button", name="See older courses")
            if older_button.is_visible():
                older_button.click()
                page.wait_for_load_state('networkidle', timeout=5000)
                time.sleep(CONFIG['delay'])
            else:
                break
        except Exception:
            break

    course_links = page.locator('a[href*="/courses/"]').all()
    for link in course_links:
        href = link.get_attribute('href')
        name = link.text_content().strip()
        if href and "/courses/" in href and name and not any(k in href for k in ["/assignments/", "/submissions/"]):
            url = f"https://www.gradescope.com{href}" if href.startswith('/') else href
            if not any(c['url'] == url for c in courses):
                courses.append({'name': name, 'url': url})
    
    print(f"Found {len(courses)} courses.")
    return courses

def download_assignment(page: Page, assignment_name: str, assignment_url: str, assignment_dir: Path):
    """Downloads files for an assignment, prioritizing direct downloads and archives over graded PDFs."""
    print(f"  -> Processing assignment: {assignment_name}")
    page.goto(assignment_url)
    page.wait_for_load_state('networkidle')

    assignment_dir.mkdir(parents=True, exist_ok=True)
    
    downloaded_successfully = False

    # --- Attempt 1: Look for direct download links (code, zips, etc.) FIRST ---
    print("    Looking for direct download links (archives, code files)...")
    direct_download_selectors = [
        'a[href*="/download_submission"]', 'a[download]', 
        'a[href$=".zip"]', 'a[href$=".tar.gz"]', 'a[href$=".tar"]', 'a[href$=".tgz"]',
        'a[href$=".py"]', 'a[href$=".java"]', 'a[href$=".cpp"]'
    ]
    
    for selector in direct_download_selectors:
        for link in page.locator(selector).all():
            try:
                print(f"    Found potential direct download link with selector '{selector}'")
                with page.expect_download(timeout=15000) as d_info:
                    link.click()
                download = d_info.value
                path = assignment_dir / download.suggested_filename
                download.save_as(path)
                print(f"      SUCCESS: Downloaded: '{download.suggested_filename}'")
                
                # --- Archive Extraction ---
                file_extension = path.suffix.lower()
                if file_extension in ['.zip', '.tar', '.gz', '.tgz']:
                    print(f"      Detected archive: {file_extension}. Attempting extraction...")
                    extract_dir = assignment_dir
                    try:
                        if file_extension == '.zip':
                            with zipfile.ZipFile(path, 'r') as zf: zf.extractall(extract_dir)
                        else: # .tar, .tar.gz, .tgz
                            with tarfile.open(path, 'r:*') as tf: tf.extractall(extract_dir)
                        print(f"      SUCCESS: Extracted primary archive to '{extract_dir}'")
                        os.remove(path)
                        print(f"      Deleted original archive: '{path.name}'")

                        # --- NEW: Scan for and extract nested archives ---
                        print("      Scanning for nested archives...")
                        for root, dirs, files in os.walk(extract_dir):
                            for filename in files:
                                nested_path = Path(root) / filename
                                nested_ext = nested_path.suffix.lower()
                                if nested_ext in ['.zip', '.tar', '.gz', '.tgz']:
                                    print(f"        Found nested archive: {filename}. Extracting...")
                                    nested_extract_dir = nested_path.parent
                                    try:
                                        if nested_ext == '.zip':
                                            with zipfile.ZipFile(nested_path, 'r') as zf: zf.extractall(nested_extract_dir)
                                        else:
                                            with tarfile.open(nested_path, 'r:*') as tf: tf.extractall(nested_extract_dir)
                                        print("        SUCCESS: Extracted nested archive.")
                                        os.remove(nested_path)
                                        print(f"        Deleted nested archive: {filename}")
                                    except Exception as nested_e:
                                        print(f"        ERROR: Failed to extract nested archive. Details: {nested_e}")
                    except Exception as extract_e:
                        print(f"      ERROR: Failed to extract archive. Details: {extract_e}")
                
                # We are done with this assignment after one successful download/extraction
                return
            except Exception as e:
                print(f"      WARNING: Direct download attempt failed. Details: {e}")

    # --- Attempt 2: If no direct downloads were found, fall back to Graded PDF ---
    if not downloaded_successfully: # This condition will now be checked if the above attempts failed
        print("    No direct downloads found. Falling back to Graded PDF download workflow...")
        try:
            download_graded_copy_link = page.get_by_role("link", name="Download Graded Copy")
            download_graded_copy_link.wait_for(state='visible', timeout=5000)
            
            pdf_url = download_graded_copy_link.get_attribute('href')
            if pdf_url:
                if pdf_url.startswith('/'):
                    pdf_url = f"https://www.gradescope.com{pdf_url}"
                
                cookies = page.context.cookies()
                requests_cookies = {cookie['name']: cookie['value'] for cookie in cookies}
                headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'}

                print(f"    Found PDF URL: {pdf_url}")
                print("    Downloading Graded PDF directly via requests...")
                response = requests.get(pdf_url, cookies=requests_cookies, headers=headers, allow_redirects=True)
                response.raise_for_status()

                sanitized_filename = "".join([c for c in assignment_name if c.isalnum() or c in '._-']).strip() + "_graded.pdf"
                (assignment_dir / sanitized_filename).write_bytes(response.content)
                
                print(f"      SUCCESS: Saved Graded PDF: '{sanitized_filename}'")
            else:
                print("      ERROR: Could not extract PDF URL from 'Download Graded Copy' link.")
                
        except Exception as e:
            print(f"      ERROR: Graded PDF download method failed. No files downloaded for this assignment.")
            print(f"      Details: {e}")
    
    time.sleep(CONFIG['delay'])
def download_course(page: Page, course: dict, output_dir: str):
    """Downloads all graded assignments for one course."""
    print(f"\nProcessing course: {course['name']}")
    sanitized_name = "".join([c for c in course['name'] if c.isalnum() or c in ' -']).strip()
    course_path = Path(output_dir) / sanitized_name
    course_path.mkdir(parents=True, exist_ok=True)
    page.goto(course['url'])
    page.wait_for_load_state('networkidle')

    assignments = []
    for row in page.locator('tbody tr').all():
        if re.search(r'\d+(\.\d+)?\s*/\s*\d+(\.\d+)?', row.text_content()) and "Submitted" not in row.text_content():
            link = row.locator('a[href*="/assignments/"]').first
            if link.is_visible():
                href = link.get_attribute('href')
                name = link.text_content().strip()
                if href and name and not any(a['url'].endswith(href) for a in assignments):
                    assignments.append({'name': name, 'url': f"https://www.gradescope.com{href}"})
    
    print(f"Found {len(assignments)} graded assignments.")
    for assign in assignments:
        assign_path = course_path / "".join([c for c in assign['name'] if c.isalnum() or c in '._-']).strip()
        download_assignment(page, assign['name'], assign['url'], assign_path)

def create_git_repo(course_dir: Path, course_name: str):
    """Initializes and pushes a git repository for a course."""
    print(f"\n--- Setting up Git repository for {course_name} ---")
    if not course_dir.is_dir():
        print(f"ERROR: Course directory '{course_dir}' not found.")
        return
        
    original_cwd = os.getcwd()
    os.chdir(course_dir)
    try:
        subprocess.run(['git', 'init'], check=True, capture_output=True)
        subprocess.run(['git', 'add', '.'], check=True, capture_output=True)
        if subprocess.run(['git', 'status', '--porcelain'], capture_output=True).stdout:
            subprocess.run(['git', 'commit', '-m', f"Initial archive for {course_name}"], check=True, capture_output=True)
        
        repo_name = "".join([c for c in course_name if c.isalnum() or c in '-']).strip().replace(' ', '-')
        if "origin" not in subprocess.run(['git', 'remote', '-v'], capture_output=True, text=True).stdout:
            print(f"Creating public GitHub repository '{repo_name}'...")
            subprocess.run(['gh', 'repo', 'create', repo_name, '--public', '--source=.', '--remote=origin'], check=True, capture_output=True, text=True)
        
        print("Pushing to GitHub...")
        subprocess.run(['git', 'branch', '-M', 'main'], check=True, capture_output=True)
        subprocess.run(['git', 'push', '-u', 'origin', 'main', '--force'], check=True, capture_output=True)
        print(f"Successfully pushed to GitHub repository: {repo_name}")
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"ERROR: Git/GitHub operation failed. Ensure 'gh' is installed and authenticated. Details: {e}")
    finally:
        os.chdir(original_cwd)

def interactive_workflow(page: Page):
    """Runs the archiver in an interactive loop."""
    while True:
        print("\n--- Gradescope Archiver Interactive Mode ---")
        all_courses = get_courses(page)
        if not all_courses: break
        for i, c in enumerate(all_courses): print(f"{i+1}. {c['name']}")
        choice = input("\nEnter a number to process, or 'q' to quit: ").strip().lower()
        if choice == 'q': break
        try:
            course = all_courses[int(choice) - 1]
            download_course(page, course, CONFIG['output_dir'])
            if input("Create and push Git repository? (y/n): ").lower() == 'y':
                sanitized_name = "".join([c for c in course['name'] if c.isalnum() or c in ' -']).strip()
                create_git_repo(Path(CONFIG['output_dir']) / sanitized_name, course['name'])
            if input("Delete local folder after push? (y/n): ").lower() == 'y':
                shutil.rmtree(Path(CONFIG['output_dir']) / sanitized_name)
                print("Local directory deleted.")
        except (ValueError, IndexError):
            print("Invalid input.")
        except Exception as e:
            print(f"An error occurred: {e}")