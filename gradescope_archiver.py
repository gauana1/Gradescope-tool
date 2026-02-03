#!/usr/bin/env python3
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright
import gradescope_lib as gs_lib

def main():
    parser = argparse.ArgumentParser(
        description="Gradescope Course Archiver. Run with --interactive for a guided experience.",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument('--setup', action='store_true', help='Perform manual login and save session state.')
    parser.add_argument('--interactive', action='store_true', help='Run in interactive mode to select courses one-by-one.')
    parser.add_argument('--download-all', action='store_true', help='Download all courses and assignments (non-interactive).')
    parser.add_argument('--test-course', type=str, help='Download a single course by its full name.')
    args = parser.parse_args()

    if args.setup:
        gs_lib.setup_auth()
        return

    if not Path(gs_lib.CONFIG['auth_file']).exists():
        print(f"Authentication file '{gs_lib.CONFIG['auth_file']}' not found. Please run with --setup first.")
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=gs_lib.CONFIG['headless'],
            args=['--disable-extensions', '--disable-pdf-extension']
        )
        context = browser.new_context(storage_state=gs_lib.CONFIG['auth_file'])
        page = context.new_page()

        if args.interactive:
            gs_lib.interactive_workflow(page)
        elif args.download_all:
            print("--- Starting Download All Mode ---")
            all_courses = gs_lib.get_courses(page)
            for course in all_courses:
                gs_lib.download_course(page, course, gs_lib.CONFIG['output_dir'])
            print("\n--- All courses have been processed. ---")
        elif args.test_course:
            print(f"--- Testing download for course: {args.test_course} ---")
            all_courses = gs_lib.get_courses(page)
            target_course = next((c for c in all_courses if c['full_name'] == args.test_course), None)
            
            if target_course:
                gs_lib.download_course(page, target_course, gs_lib.CONFIG['output_dir'])
                print(f"\n--- Test download finished for {args.test_course}. ---")
            else:
                print(f"ERROR: Course '{args.test_course}' not found.")
                print("Please make sure you are using the exact full name from the course list.")
        else:
            print("--- Listing All Discovered Courses (run with --interactive or --test-course to download) ---")
            all_courses = gs_lib.get_courses(page)
            if all_courses:
                for course in all_courses:
                    print(f"- {course['full_name']}")
        
        browser.close()
        print("\nDone.")

if __name__ == '__main__':
    main()
