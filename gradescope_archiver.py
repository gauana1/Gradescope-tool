#!/usr/bin/env python3
import os
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
import subprocess
import argparse
import re
import requests

CONFIG = {
    'output_dir': 'gradescope_archive',
    'auth_file': 'gradescope_auth.json',
    'delay': 2,
    'headless': False, # Set to True once fully tested
    'max_retries': 3
}

def setup_auth():
    """Manual login + save session"""
    print("Setting up authentication. A browser window will open.")
    print("Please log in to Gradescope manually, including any 2FA.")
    print("IMPORTANT: Once you see your main Gradescope dashboard, please CLOSE THE BROWSER WINDOW to continue.")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        try:
            page.goto("https://www.gradescope.com/")
            # This is a trick to wait indefinitely until the user closes the browser.
            # The function will never return true, so it will only stop when the page closes.
            page.wait_for_function("() => false", timeout=0)
        except Exception:
            # This exception is expected when the user closes the browser.
            print("\nBrowser closed by user. Assuming login was successful.")
        
        # Save the session state to the file.
        context.storage_state(path=CONFIG['auth_file'])
        print(f"Authentication session successfully saved to {CONFIG['auth_file']}.")


def get_courses(page):


    """Return list of course dicts"""


    print("Discovering courses...")


    # Go to the main page first


    page.goto('https://www.gradescope.com/')


    page.wait_for_load_state('networkidle')





    try:


        # Click the main Gradescope logo to ensure we're on the dashboard


        print("Navigating to main course dashboard...")


        page.get_by_role("link", name="Gradescope: Back to Home").click()


        page.wait_for_load_state('networkidle')


    except Exception as e:


        print(f"Could not click 'Gradescope: Back to Home' link, might already be on the right page. Error: {e}")


        # If this fails, we might already be on the courses page, so we continue


        page.goto('https://www.gradescope.com/courses')


        page.wait_for_load_state('networkidle')





    courses = [] # Initialize 'courses' here!





    # Keep clicking "See older courses" until it's gone


    while True:


        try:


            # Use get_by_role for the older button as identified by codegen


            older_button = page.get_by_role("button", name="See older courses")


            


            if older_button.is_visible(): # Check if button is actually on page


                print("Clicking 'See older courses'...")


                older_button.click()


                page.wait_for_load_state('networkidle', timeout=5000)


                time.sleep(CONFIG['delay'])


            else:


                break  # No more older courses button


        except Exception as e:


            # This catch can sometimes happen if button disappears during check


            # or if it's genuinely not there.


            # print(f"No more 'See older courses' button or an error occurred: {e}")


            break # Exit loop if button not found or error occurred





        courses = []





        





        # Try to find all links that could be course links





        # This selector combines the original spec's idea with get_by_role hint





        course_candidate_links = page.locator('a[href*="/courses/"]').all()





    





        for link_element in course_candidate_links:





            href = link_element.get_attribute('href') # Use get_attribute





            text_content = link_element.text_content().strip()





    





            # Basic filtering: ensure it has an href, contains "/courses/", and has some text





            if href and "/courses/" in href and text_content and text_content != "":





                # Further filtering: avoid common links that are not actual course entries





                # such as links to assignments *within* a course, or navigation links





                if not any(keyword in href for keyword in ["/assignments/", "/submissions/", "/outline/", "/grades/", "/announcements/", "/settings/"]):





                    # Ensure it's not a duplicate if already added





                    course_url = f"https://www.gradescope.com{href}" if href.startswith('/') else href





                    if not any(c['url'] == course_url for c in courses):





                        courses.append({





                            'name': text_content,





                            'url': course_url,





                            'term': None # Term extraction is complex, keep as None for now





                        })


    


    print(f"Found {len(courses)} courses.")


    return courses

def download_assignment(page, assignment_name, assignment_url, assignment_dir):
    """Downloads files for an assignment using the requests library for direct download."""
    print(f"  -> Processing assignment: {assignment_name}")
    page.goto(assignment_url)
    page.wait_for_load_state('networkidle')

    assignment_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        print("    Looking for 'Download Graded Copy' link...")
        download_graded_copy_link = page.get_by_role("link", name="Download Graded Copy")
        download_graded_copy_link.wait_for(state='visible', timeout=10000)
        
        pdf_url = download_graded_copy_link.get_attribute('href')
        
        if pdf_url:
            if pdf_url.startswith('/'):
                pdf_url = f"https://www.gradescope.com{pdf_url}"
            
            print(f"    Found PDF URL: {pdf_url}")
            
            # Get cookies from the Playwright context to make an authenticated request
            cookies = page.context.cookies()
            requests_cookies = {cookie['name']: cookie['value'] for cookie in cookies}

            print("    Downloading PDF directly via requests...")
            response = requests.get(pdf_url, cookies=requests_cookies, allow_redirects=True)
            response.raise_for_status()  # Raise an exception for bad status codes

            # Save the file
            sanitized_filename = "".join([c for c in assignment_name if c.isalnum() or c in ('.', '_', '-')]).strip() + "_graded.pdf"
            save_path = assignment_dir / sanitized_filename
            
            with open(save_path, "wb") as f:
                f.write(response.content)
            
            print(f"      SUCCESS: Saved '{sanitized_filename}'")
        else:
            print("      ERROR: Could not extract PDF URL from link")
            
    except Exception as e:
        print(f"      ERROR: An error occurred during the download process for '{assignment_name}'.")
        print(f"      Details: {e}")
    
    time.sleep(CONFIG['delay'])


def download_course(page, course, output_dir):
    """Download all assignments for one course"""
    print(f"Starting download for course: '{course['name']}'")
    
    # Sanitize course name for directory
    sanitized_course_name = "".join([c for c in course['name'] if c.isalnum() or c in (' ', '-')]).strip()
    sanitized_course_name = sanitized_course_name.split(" assignments")[0] # Clean up name
    course_path = Path(output_dir) / sanitized_course_name
    course_path.mkdir(parents=True, exist_ok=True)

    # Navigate to course page
    page.goto(course['url'])
    page.wait_for_load_state('networkidle')

    # First, find the index of the "Status" column using a more robust locator
    status_column_header = page.get_by_role("columnheader", name="Status")
    if status_column_header.is_visible():
        all_headers = page.locator('thead th').all() # Get all header elements
        status_column_index = -1
        for i, header_elem in enumerate(all_headers):
            if header_elem == status_column_header: # Compare Playwright ElementHandle objects
                status_column_index = i
                break
        if status_column_index == -1:
            print("Warning: Found 'Status' header but could not determine its index. Falling back to less reliable check.")
    else:
        print("Warning: Could not find 'Status' column header. Falling back to less reliable check.")
    
    if status_column_index == -1:
        # Fallback to checking all cells if the specific 'Status' column can't be identified
        # This fallback is less reliable but better than nothing.
        print("Could not reliably find 'Status' column. Checking all cells for score or 'Submitted' status.")

    assignments_to_download = []
    table_rows = page.locator('tbody tr').all()
    print(f"Scanning {len(table_rows)} assignments...")

    for row in table_rows:
        is_graded = False
        assignment_link_element = row.locator('a[href*="/assignments/"]').first
        assignment_title = assignment_link_element.text_content().strip() if assignment_link_element.is_visible() else "Unknown Assignment"

        if status_column_index != -1:
            # Precise check: only look in the 'Status' column
            cells = row.locator('td').all()
            if len(cells) > status_column_index:
                status_cell_text = cells[status_column_index].text_content().strip()
                # Check for score pattern (e.g., "94.0 / 100.0")
                if re.search(r'\d+(\.\d+)?\s*/\s*\d+(\.\d+)?', status_cell_text):
                    is_graded = True
                elif "Submitted" in status_cell_text:
                    is_graded = False # Explicitly mark as not graded if submitted without score
                # else: could be 'Not Submitted', 'Late', etc., which are also not graded
            else:
                print(f"Skipping assignment '{assignment_title}' (Status column out of bounds).")
        else:
            # Fallback check: look for a score pattern in any cell, and not 'Submitted'
            row_text = row.text_content()
            if re.search(r'\d+(\.\d+)?\s*/\s*\d+(\.\d+)?', row_text) and "Submitted" not in row_text:
                is_graded = True
            elif "Submitted" in row_text:
                is_graded = False # Submitted without score means not graded
            # else: not graded if no score and not explicitly submitted
        
        if is_graded:
            href = assignment_link_element.get_attribute('href')
            if href and assignment_title and not any(a['url'].endswith(href) for a in assignments_to_download):
                assignments_to_download.append({
                    "name": assignment_title,
                    "url": f"https://www.gradescope.com{href}" if href.startswith('/') else href
                })
        else:
            print(f"Skipping assignment '{assignment_title}' (Not identified as graded).")

    print(f"Found {len(assignments_to_download)} graded assignments for this course.")

    # Write course_info.json and README.md
    course_info = {
        "course_name": course['name'],
        "term": course.get('term'),
        "gradescope_url": course['url'],
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "total_assignments": len(assignments_to_download)
    }
    with open(course_path / "course_info.json", "w") as f:
        json.dump(course_info, f, indent=2)

    readme_content = f"# {course['name']}\n\nCourse materials archived from Gradescope\n\n**Term**: {course.get('term', 'N/A')}\n**Downloaded**: {course_info['downloaded_at']}\n\n## Assignments\n"
    for assignment in assignments_to_download:
        readme_content += f"- {assignment['name']}\n"
    with open(course_path / "README.md", "w") as f:
        f.write(readme_content)

    # Download each assignment
    for assignment in assignments_to_download:
        sanitized_assignment_name = "".join([c for c in assignment['name'] if c.isalnum() or c in (' ', '-')]).strip()
        assignment_dir = course_path / sanitized_assignment_name
        download_assignment(page, assignment['name'], assignment['url'], assignment_dir)
        
    print(f"Finished downloading course '{course['name']}'.")

def create_git_repo(course_dir):
    """Initialize git repo"""
    print(f"Placeholder: Creating git repo for {course_dir}")
    os.chdir(course_dir)
    subprocess.run(['git', 'init'], capture_output=True, text=True)
    subprocess.run(['git', 'add', '.'], capture_output=True, text=True)
    subprocess.run(['git', 'commit', '-m', 'Initial commit: Gradescope archive'], capture_output=True, text=True)
    os.chdir("../..") # Go back to original directory
    print(f"Git repo initialized for {course_dir}")


def main():
    parser = argparse.ArgumentParser(description="Gradescope Course Archiver")
    parser.add_argument('--setup', action='store_true', help='Perform manual login and save session state.')
    parser.add_argument('--download', action='store_true', help='Download all courses and assignments.')
    parser.add_argument('--create-repos', action='store_true', help='Create Git repositories for archived courses.')
    parser.add_argument('--all', action='store_true', help='Run setup, download, and create repos.')

    args = parser.parse_args()

    # Ensure output directory exists
    Path(CONFIG['output_dir']).mkdir(parents=True, exist_ok=True)

    if args.all:
        args.setup = True
        args.download = True
        args.create_repos = True

    if args.setup:
        setup_auth()
        if not (args.download or args.create_repos): # If only setup was requested, we're done
            return

    # From here, we assume auth is set up and we need to do some action (download, create-repos, or just list)
    if not Path(CONFIG['auth_file']).exists():
        print(f"Authentication file {CONFIG['auth_file']} not found. Please run with --setup first.")
        return

    # If we reach here, we have an auth file and need to use the browser
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=CONFIG['headless'])
        context = browser.new_context(storage_state=CONFIG['auth_file'])
        page = context.new_page()

        print("Attempting to get courses...")
        courses = get_courses(page) # This will always be called now if auth file exists
        if not courses:
            print("No courses found. Exiting.")
            browser.close()
            return
        
        # Now handle the different actions based on arguments
        if args.download:
            print("\nStarting course download...")
            for course in courses:
                download_course(page, course, CONFIG['output_dir'])
                time.sleep(CONFIG['delay'])
            print("Course download process completed.")
        
        elif args.create_repos: # Use elif to ensure only one main action is done if explicitly specified
            print("\nCreating Git repositories...")
            current_dir = os.getcwd()
            for course in courses:
                sanitized_course_name = "".join([c for c in course['name'] if c.isalnum() or c in (' ', '-')]).strip()
                course_path = Path(CONFIG['output_dir']) / sanitized_course_name
                if course_path.is_dir():
                    create_git_repo(course_path)
                os.chdir(current_dir)
            print("Git repository creation placeholder completed.")
        
        else: # No download or create_repos, so just list courses (the default behavior)
            print("\nDiscovered Courses:")
            for course in courses:
                print(f"- {course['name']} ({course['url']})")
        
        browser.close() # Ensure browser is closed after all operations.


if __name__ == '__main__':
    main()

 