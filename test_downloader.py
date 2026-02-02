#!/usr/bin/env python3
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright
import gradescope_lib as gs_lib

def main():
    parser = argparse.ArgumentParser(description="Test the Gradescope assignment downloader.")
    parser.add_argument('assignment_url', help='The full URL of the assignment to download.')
    parser.add_argument('--name', help="An optional name for the assignment (used for folder creation).", default="TestAssignment")
    args = parser.parse_args()

    # --- Auth Check ---
    if not Path(gs_lib.CONFIG['auth_file']).exists():
        print(f"Authentication file '{gs_lib.CONFIG['auth_file']}' not found. Please run 'gradescope_archiver.py --setup' first.")
        return

    print(f"--- Running single assignment test for URL: {args.assignment_url} ---")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=gs_lib.CONFIG['headless'],
            args=['--disable-extensions', '--disable-pdf-extension']
        )
        context = browser.new_context(storage_state=gs_lib.CONFIG['auth_file'])
        page = context.new_page()

        # Define a temporary directory for the test download
        test_dir = Path(gs_lib.CONFIG['output_dir']) / "TEST_DOWNLOADS" / args.name
        test_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"Output directory: {test_dir.resolve()}")

        # Call the download function
        gs_lib.download_assignment(page, args.name, args.assignment_url, test_dir)

        browser.close()
        print("\n--- Test complete. ---")

if __name__ == '__main__':
    main()
